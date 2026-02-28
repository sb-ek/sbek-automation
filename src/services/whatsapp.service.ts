import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { settings } from './settings.service.js';

// ── Interfaces ──────────────────────────────────────────────────────

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  parameters: TemplateParameter[];
}

export interface TemplateParameter {
  type: 'text' | 'image' | 'document';
  text?: string;
  image?: { link: string };
}

export interface WhatsAppResponse {
  messaging_product: string;
  contacts: Array<{ wa_id: string }>;
  messages: Array<{ id: string }>;
}

// ── Service ─────────────────────────────────────────────────────────

class WhatsAppService {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor() {
    this.baseUrl = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}`;
    this.headers = {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    };
  }

  /** Re-initialize the WhatsApp client with the latest credentials from settings */
  async refreshClient(): Promise<void> {
    const phoneId = await settings.get('WHATSAPP_PHONE_NUMBER_ID');
    const token = await settings.get('WHATSAPP_ACCESS_TOKEN');
    if (phoneId || token) {
      this.baseUrl = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${phoneId ?? env.WHATSAPP_PHONE_NUMBER_ID}`;
      this.headers = {
        Authorization: `Bearer ${token ?? env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      };
    }
  }

  // ── Public methods ───────────────────────────────────────────────

  /**
   * Send a pre-approved WhatsApp template message.
   * Returns the message ID assigned by the WhatsApp Cloud API.
   */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    components?: TemplateComponent[],
  ): Promise<string> {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components && { components }),
      },
    };

    try {
      const data = await this.post('/messages', body);
      const messageId = data.messages[0].id;
      logger.info({ to, templateName, messageId }, 'WhatsApp template sent');
      return messageId;
    } catch (error) {
      logger.error({ to, templateName, error }, 'Failed to send WhatsApp template');
      throw error;
    }
  }

  /**
   * Send a plain-text WhatsApp message.
   */
  async sendText(to: string, text: string): Promise<string> {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    };

    try {
      const data = await this.post('/messages', body);
      const messageId = data.messages[0].id;
      logger.info({ to, messageId }, 'WhatsApp text message sent');
      return messageId;
    } catch (error) {
      logger.error({ to, error }, 'Failed to send WhatsApp text message');
      throw error;
    }
  }

  /**
   * Send an image message with an optional caption.
   */
  async sendImage(
    to: string,
    imageUrl: string,
    caption?: string,
  ): Promise<string> {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: {
        link: imageUrl,
        ...(caption && { caption }),
      },
    };

    try {
      const data = await this.post('/messages', body);
      const messageId = data.messages[0].id;
      logger.info({ to, messageId }, 'WhatsApp image message sent');
      return messageId;
    } catch (error) {
      logger.error({ to, imageUrl, error }, 'Failed to send WhatsApp image message');
      throw error;
    }
  }

  // ── Private helper ───────────────────────────────────────────────

  /**
   * Low-level POST to the WhatsApp Cloud API with a 30-second timeout.
   */
  private async post(endpoint: string, body: unknown): Promise<WhatsAppResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { status: response.status, errorBody, endpoint },
          'WhatsApp API error response',
        );
        throw new Error(
          `WhatsApp API responded with ${response.status}: ${errorBody}`,
        );
      }

      return (await response.json()) as WhatsAppResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const whatsapp = new WhatsAppService();
