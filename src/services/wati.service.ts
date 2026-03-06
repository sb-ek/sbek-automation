import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { settings } from './settings.service.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface WatiTemplateParam {
  name: string;
  value: string;
}

interface WatiResponse {
  result: boolean;
  info?: string;
}

type Provider = 'wati' | 'interakt';

// ── Service ────────────────────────────────────────────────────────────────

/**
 * Wati / Interakt WhatsApp backup service.
 *
 * Used as a fallback when the primary Meta WhatsApp Cloud API fails.
 * Tries Wati first (if configured), then Interakt.
 */
class WatiService {
  /**
   * Send a template message via the first available backup provider.
   * Tries Wati → Interakt in order.
   */
  async sendTemplate(
    to: string,
    templateName: string,
    params: Record<string, string>,
  ): Promise<{ provider: Provider; messageId: string }> {
    // Try Wati first
    const watiKey = (await settings.get('WATI_API_KEY')) ?? env.WATI_API_KEY;
    const watiUrl = (await settings.get('WATI_BASE_URL')) ?? env.WATI_BASE_URL;
    if (watiKey && watiUrl) {
      try {
        const messageId = await this.sendViaWati(to, templateName, params);
        return { provider: 'wati', messageId };
      } catch (err) {
        logger.warn({ err, to, templateName }, 'Wati send failed, trying Interakt');
      }
    }

    // Fall back to Interakt
    const interaktKey = (await settings.get('INTERAKT_API_KEY')) ?? env.INTERAKT_API_KEY;
    if (interaktKey) {
      try {
        const messageId = await this.sendViaInterakt(to, templateName, params);
        return { provider: 'interakt', messageId };
      } catch (err) {
        logger.error({ err, to, templateName }, 'Interakt send also failed');
        throw err;
      }
    }

    throw new Error('No WhatsApp backup provider configured (WATI or INTERAKT)');
  }

  /**
   * Send a plain text message via the first available backup provider.
   */
  async sendText(
    to: string,
    text: string,
  ): Promise<{ provider: Provider; messageId: string }> {
    const watiKey2 = (await settings.get('WATI_API_KEY')) ?? env.WATI_API_KEY;
    const watiUrl2 = (await settings.get('WATI_BASE_URL')) ?? env.WATI_BASE_URL;
    if (watiKey2 && watiUrl2) {
      try {
        const messageId = await this.sendTextViaWati(to, text);
        return { provider: 'wati', messageId };
      } catch (err) {
        logger.warn({ err, to }, 'Wati text send failed, trying Interakt');
      }
    }

    const interaktKey2 = (await settings.get('INTERAKT_API_KEY')) ?? env.INTERAKT_API_KEY;
    if (interaktKey2) {
      try {
        const messageId = await this.sendTextViaInterakt(to, text);
        return { provider: 'interakt', messageId };
      } catch (err) {
        logger.error({ err, to }, 'Interakt text send also failed');
        throw err;
      }
    }

    throw new Error('No WhatsApp backup provider configured (WATI or INTERAKT)');
  }

  /** Returns true if at least one backup provider is configured */
  isConfigured(): boolean {
    return !!(env.WATI_API_KEY || env.INTERAKT_API_KEY);
  }

  /** Check settings DB for dynamically configured keys */
  async isConfiguredAsync(): Promise<boolean> {
    const watiKey = await settings.get('WATI_API_KEY');
    const interaktKey = await settings.get('INTERAKT_API_KEY');
    return !!(watiKey || interaktKey);
  }

  // ── Wati Implementation ──────────────────────────────────────────────

  private async sendViaWati(
    to: string,
    templateName: string,
    params: Record<string, string>,
  ): Promise<string> {
    const phone = to.replace(/^\+/, '');
    const watiKey = (await settings.get('WATI_API_KEY')) ?? env.WATI_API_KEY;
    const watiUrl = (await settings.get('WATI_BASE_URL')) ?? env.WATI_BASE_URL;
    const body = {
      template_name: templateName,
      broadcast_name: `sbek_${templateName}_${Date.now()}`,
      parameters: Object.entries(params).map(
        ([name, value]): WatiTemplateParam => ({ name, value }),
      ),
    };

    const res = await fetch(
      `${watiUrl}/api/v1/sendTemplateMessage?whatsappNumber=${phone}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${watiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Wati API ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as WatiResponse;
    const messageId = data.info ?? `wati-${Date.now()}`;
    logger.info({ to: phone, templateName, messageId, provider: 'wati' }, 'WhatsApp sent via Wati');
    return messageId;
  }

  private async sendTextViaWati(to: string, text: string): Promise<string> {
    const phone = to.replace(/^\+/, '');
    const watiKey = (await settings.get('WATI_API_KEY')) ?? env.WATI_API_KEY;
    const watiUrl = (await settings.get('WATI_BASE_URL')) ?? env.WATI_BASE_URL;

    const res = await fetch(
      `${watiUrl}/api/v1/sendSessionMessage/${phone}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${watiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messageText: text }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Wati text API ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as WatiResponse;
    const messageId = data.info ?? `wati-text-${Date.now()}`;
    logger.info({ to: phone, provider: 'wati' }, 'WhatsApp text sent via Wati');
    return messageId;
  }

  // ── Interakt Implementation ──────────────────────────────────────────

  private async sendViaInterakt(
    to: string,
    templateName: string,
    params: Record<string, string>,
  ): Promise<string> {
    const phone = to.replace(/^\+/, '');
    const body = {
      countryCode: phone.startsWith('91') ? '+91' : `+${phone.slice(0, 2)}`,
      phoneNumber: phone.startsWith('91') ? phone.slice(2) : phone,
      type: 'Template',
      template: {
        name: templateName,
        languageCode: 'en',
        bodyValues: Object.values(params),
      },
    };

    const interaktKey = (await settings.get('INTERAKT_API_KEY')) ?? env.INTERAKT_API_KEY;

    const res = await fetch(
      'https://api.interakt.ai/v1/public/message/',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${interaktKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Interakt API ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as { id?: string; result?: boolean };
    const messageId = data.id ?? `interakt-${Date.now()}`;
    logger.info({ to: phone, templateName, messageId, provider: 'interakt' }, 'WhatsApp sent via Interakt');
    return messageId;
  }

  private async sendTextViaInterakt(to: string, text: string): Promise<string> {
    const phone = to.replace(/^\+/, '');
    const interaktKey = (await settings.get('INTERAKT_API_KEY')) ?? env.INTERAKT_API_KEY;
    const body = {
      countryCode: phone.startsWith('91') ? '+91' : `+${phone.slice(0, 2)}`,
      phoneNumber: phone.startsWith('91') ? phone.slice(2) : phone,
      type: 'Text',
      data: { message: text },
    };

    const res = await fetch(
      'https://api.interakt.ai/v1/public/message/',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${interaktKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Interakt text API ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as { id?: string };
    const messageId = data.id ?? `interakt-text-${Date.now()}`;
    logger.info({ to: phone, provider: 'interakt' }, 'WhatsApp text sent via Interakt');
    return messageId;
  }
}

// ── Singleton Export ──────────────────────────────────────────────────────────

export const wati = new WatiService();
