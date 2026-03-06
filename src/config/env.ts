import { z } from 'zod';

const envSchema = z.object({
  // ── App ────────────────────────────────────────────────
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // ── Public URL ────────────────────────────────────────
  PUBLIC_URL: z.string().url().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().min(1).optional(),

  // ── Database ───────────────────────────────────────────
  DATABASE_URL: z.string().url(),

  // ── Redis ──────────────────────────────────────────────
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // ── WooCommerce ────────────────────────────────────────
  WOO_URL: z.string().url().optional(),
  WOO_CONSUMER_KEY: z.string().min(1).optional(),
  WOO_CONSUMER_SECRET: z.string().min(1).optional(),
  WOO_WEBHOOK_SECRET: z.string().min(1).optional(),

  // ── Google ─────────────────────────────────────────────
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  GOOGLE_PRIVATE_KEY: z.string().min(1).optional(),
  GOOGLE_SHEET_ID: z.string().min(1).optional(),
  GOOGLE_DRIVE_FOLDER_ID: z.string().min(1).optional(),

  // ── WhatsApp / Meta ────────────────────────────────────
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),

  // ── Email / SMTP ───────────────────────────────────────
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),

  // ── OpenRouter (all AI — text + image generation) ────
  OPENROUTER_API_KEY: z.string().min(1).optional(),

  // ── Google OAuth (alternative to service account) ───
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_OAUTH_REFRESH_TOKEN: z.string().min(1).optional(),

  // ── Wati (WhatsApp backup) ───────────────────────────
  WATI_API_KEY: z.string().min(1).optional(),
  WATI_BASE_URL: z.string().url().optional(),

  // ── Interakt (WhatsApp backup) ───────────────────────
  INTERAKT_API_KEY: z.string().min(1).optional(),

  // ── Crawler ────────────────────────────────────────────
  CRAWLER_BASE_URL: z.string().url().default('http://crawler:3001'),

  // ── Admin dashboard ────────────────────────────────────
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(1),

  // ── Branding ───────────────────────────────────────────
  BRAND_NAME: z.string().min(1).default('SBEK'),
  BRAND_PRIMARY_COLOR: z.string().min(1).default('#C5A572'),
  BRAND_OWNER_EMAIL: z.string().email().optional(),
  BRAND_WEBSITE: z.string().url().optional(),
  BRAND_SUPPORT_PHONE: z.string().min(1).optional(),
  BRAND_SUPPORT_EMAIL: z.string().email().optional(),
  REVIEW_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (result.success) {
    return result.data;
  }

  const { fieldErrors } = result.error.flatten();
  const formatted = Object.entries(fieldErrors)
    .map(([key, msgs]) => `  ${key}: ${msgs?.join(', ')}`)
    .join('\n');

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `Invalid environment variables:\n${formatted}`,
    );
  }

  // In development / test, log warnings for every invalid field and
  // return a best-effort partial parse so the app can still boot for
  // local iteration on features that don't need every service.
  console.warn(
    '[env] WARNING — some environment variables are missing or invalid:\n' +
      formatted,
  );

  // Re-parse with the raw object so we get defaults filled in for the
  // fields that *are* valid; missing required fields will be undefined.
  const fallback = envSchema.partial().safeParse(process.env);
  return (fallback.success ? fallback.data : {}) as Env;
}

export const env: Env = parseEnv();
