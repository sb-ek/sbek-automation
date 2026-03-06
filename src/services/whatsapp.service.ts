import { logger } from '../config/logger.js';
import { settings } from './settings.service.js';
import { env } from '../config/env.js';

// ── Types ───────────────────────────────────────────────────────────

export interface InteraktResponse {
  id?: string;
  result?: boolean;
  message?: string;
}

// ── Service ─────────────────────────────────────────────────────────

/**
 * WhatsApp service powered by Interakt.
 *
 * All WhatsApp messages (order updates, alerts, review requests)
 * are sent through the Interakt API.
 */
class WhatsAppService {
  private readonly baseUrl = 'https://api.interakt.ai/v1/public/message/';

  /** Resolve the Interakt API key from DB settings or env */
  private async getApiKey(): Promise<string | undefined> {
    return (await settings.get('INTERAKT_API_KEY')) ?? env.INTERAKT_API_KEY;
  }

  /** Returns true if an Interakt API key is configured */
  async isConfigured(): Promise<boolean> {
    const key = await this.getApiKey();
    return !!key;
  }

  /**
   * Send a pre-approved WhatsApp template message via Interakt.
   */
  async sendTemplate(
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

    const data = await this.post(body);
    const messageId = data.id ?? `interakt-${Date.now()}`;
    logger.info({ to: phone, templateName, messageId }, 'WhatsApp template sent via Interakt');
    return messageId;
  }

  /**
   * Send a plain-text WhatsApp message via Interakt.
   */
  async sendText(to: string, text: string): Promise<string> {
    const phone = to.replace(/^\+/, '');
    const body = {
      countryCode: phone.startsWith('91') ? '+91' : `+${phone.slice(0, 2)}`,
      phoneNumber: phone.startsWith('91') ? phone.slice(2) : phone,
      type: 'Text',
      data: { message: text },
    };

    const data = await this.post(body);
    const messageId = data.id ?? `interakt-text-${Date.now()}`;
    logger.info({ to: phone, messageId }, 'WhatsApp text sent via Interakt');
    return messageId;
  }

  // ── Private helper ───────────────────────────────────────────────

  private async post(body: unknown): Promise<InteraktResponse> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('INTERAKT_API_KEY not configured — set it in Dashboard → Settings or as an env var');
    }

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errBody = await res.text();
      logger.error({ status: res.status, errBody }, 'Interakt API error');
      throw new Error(`Interakt API ${res.status}: ${errBody}`);
    }

    return (await res.json()) as InteraktResponse;
  }
}

export const whatsapp = new WhatsAppService();
