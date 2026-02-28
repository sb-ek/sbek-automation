import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { systemConfig } from '../db/schema.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * All client-configurable API keys and settings.
 * These are the keys stored in the `system_config` table
 * that override the corresponding env vars at runtime.
 */
export const CONFIGURABLE_KEYS = [
  // WooCommerce
  'WOO_URL',
  'WOO_CONSUMER_KEY',
  'WOO_CONSUMER_SECRET',
  'WOO_WEBHOOK_SECRET',

  // Google Sheets
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'GOOGLE_SHEET_ID',

  // WhatsApp — Meta (primary)
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',

  // WhatsApp — Wati (backup)
  'WATI_API_KEY',
  'WATI_BASE_URL',

  // WhatsApp — Interakt (backup)
  'INTERAKT_API_KEY',

  // Email / SMTP
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'EMAIL_FROM',

  // OpenAI
  'OPENAI_API_KEY',

  // Gemini / Nano Banana
  'GEMINI_API_KEY',

  // Postiz (social media)
  'POSTIZ_API_KEY',
  'POSTIZ_BASE_URL',

  // Crawler
  'CRAWLER_BASE_URL',

  // Brand config
  'BRAND_NAME',
  'BRAND_PRIMARY_COLOR',
  'BRAND_WEBSITE',
  'BRAND_SUPPORT_PHONE',
  'BRAND_SUPPORT_EMAIL',
  'REVIEW_URL',
] as const;

export type ConfigurableKey = (typeof CONFIGURABLE_KEYS)[number];

/** Describes a single setting for the admin UI */
export interface SettingInfo {
  key: ConfigurableKey;
  /** Whether the value is set (DB override or env) */
  configured: boolean;
  /** Source: 'database' if overridden, 'env' if using env var, 'none' if not set */
  source: 'database' | 'env' | 'none';
  /** Masked value (first 4 + last 4 chars, rest asterisks). Empty if not set. */
  maskedValue: string;
}

// ── Service ────────────────────────────────────────────────────────────────

class SettingsService {
  /** In-memory cache: key → value. Populated on first read / after writes. */
  private cache = new Map<string, string>();
  private cacheLoaded = false;

  /**
   * Get the effective value for a config key.
   * Priority: database override → env variable → undefined
   */
  async get(key: ConfigurableKey): Promise<string | undefined> {
    await this.ensureCache();

    // DB override takes priority
    const dbValue = this.cache.get(key);
    if (dbValue !== undefined) return dbValue;

    // Fall back to env
    return (env as Record<string, unknown>)[key] as string | undefined;
  }

  /**
   * Set (or update) a config key in the database.
   * Pass `null` to remove the DB override and fall back to env.
   */
  async set(key: ConfigurableKey, value: string | null): Promise<void> {
    if (value === null) {
      // Remove override
      await db.delete(systemConfig).where(eq(systemConfig.key, key));
      this.cache.delete(key);
      logger.info({ key }, 'Setting removed (reverting to env)');
      return;
    }

    // Upsert
    const existing = await db
      .select()
      .from(systemConfig)
      .where(eq(systemConfig.key, key))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(systemConfig)
        .set({ value: JSON.stringify(value), updatedAt: new Date() })
        .where(eq(systemConfig.key, key));
    } else {
      await db.insert(systemConfig).values({
        key,
        value: JSON.stringify(value),
      });
    }

    this.cache.set(key, value);
    logger.info({ key }, 'Setting updated in database');
  }

  /**
   * Bulk-set multiple keys at once. Pass `null` for a value to remove it.
   */
  async setMany(entries: Partial<Record<ConfigurableKey, string | null>>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      await this.set(key as ConfigurableKey, value ?? null);
    }
  }

  /**
   * List all configurable keys with their status (configured, source, masked value).
   * Sensitive keys are masked — only first 4 and last 4 characters are shown.
   */
  async list(): Promise<SettingInfo[]> {
    await this.ensureCache();

    return CONFIGURABLE_KEYS.map((key) => {
      const dbValue = this.cache.get(key);
      const envValue = (env as Record<string, unknown>)[key] as string | undefined;

      let source: SettingInfo['source'] = 'none';
      let rawValue: string | undefined;

      if (dbValue !== undefined) {
        source = 'database';
        rawValue = dbValue;
      } else if (envValue !== undefined && envValue !== '') {
        source = 'env';
        rawValue = String(envValue);
      }

      return {
        key,
        configured: source !== 'none',
        source,
        maskedValue: rawValue ? maskValue(key, rawValue) : '',
      };
    });
  }

  /**
   * Force-reload the in-memory cache from the database.
   */
  async refresh(): Promise<void> {
    const rows = await db.select().from(systemConfig);
    this.cache.clear();

    for (const row of rows) {
      // value is stored as JSONB, so it's JSON-encoded
      const val = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
      // Strip surrounding quotes from JSON string values
      const parsed = val.startsWith('"') && val.endsWith('"') ? JSON.parse(val) as string : val;
      this.cache.set(row.key, parsed);
    }

    this.cacheLoaded = true;
    logger.info({ count: rows.length }, 'Settings cache refreshed from database');
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async ensureCache(): Promise<void> {
    if (!this.cacheLoaded) {
      await this.refresh();
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Keys whose values are always fully masked (show no characters) */
const FULLY_MASKED_KEYS = new Set([
  'WOO_CONSUMER_SECRET',
  'WOO_WEBHOOK_SECRET',
  'GOOGLE_PRIVATE_KEY',
  'WHATSAPP_ACCESS_TOKEN',
  'SMTP_PASS',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'WATI_API_KEY',
  'INTERAKT_API_KEY',
  'POSTIZ_API_KEY',
]);

function maskValue(key: string, value: string): string {
  if (FULLY_MASKED_KEYS.has(key)) {
    if (value.length <= 8) return '****';
    return `${value.slice(0, 4)}${'*'.repeat(Math.min(value.length - 8, 20))}${value.slice(-4)}`;
  }
  // Non-secret values (URLs, names, etc.) can be shown in full
  return value;
}

// ── Singleton Export ──────────────────────────────────────────────────────────

export const settings = new SettingsService();
