import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { google } from 'googleapis';
import Handlebars from 'handlebars';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { settings } from './settings.service.js';

// ── ES-module __dirname equivalent ──────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Handlebars helpers ──────────────────────────────────────────────

/**
 * Format a date string as "27 Feb 2026".
 * Usage: {{formatDate someDate}}
 */
Handlebars.registerHelper('formatDate', (value: string) => {
  const date = new Date(value);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
});

/**
 * Format a number as Indian Rupees: ₹1,234
 * Usage: {{formatCurrency amount}}
 */
Handlebars.registerHelper('formatCurrency', (value: number) => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
});

// ── Service ─────────────────────────────────────────────────────────

class EmailService {
  private transporter: Transporter;
  private readonly templates = new Map<string, HandlebarsTemplateDelegate>();
  /** Hash of SMTP credentials used to create the current transporter */
  private smtpHash = '';

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
      tls: { rejectUnauthorized: false },
    });
    this.smtpHash = this.hashCreds(env.SMTP_HOST, String(env.SMTP_PORT), env.SMTP_USER, env.SMTP_PASS);

    this.loadTemplates();
  }

  /**
   * Get the SMTP transporter, re-creating it if credentials have been
   * updated via the Settings dashboard.
   */
  private async getTransporter(): Promise<Transporter> {
    const host = (await settings.get('SMTP_HOST')) ?? env.SMTP_HOST;
    const port = (await settings.get('SMTP_PORT')) ?? String(env.SMTP_PORT);
    const user = (await settings.get('SMTP_USER')) ?? env.SMTP_USER;
    const pass = (await settings.get('SMTP_PASS')) ?? env.SMTP_PASS;
    const hash = this.hashCreds(host, port, user, pass);

    if (hash !== this.smtpHash) {
      const portNum = parseInt(port, 10) || 587;
      this.transporter = nodemailer.createTransport({
        host,
        port: portNum,
        secure: portNum === 465,
        auth: { user, pass },
        tls: { rejectUnauthorized: false },
      });
      this.smtpHash = hash;
      logger.info('SMTP transporter re-created with updated credentials');
    }

    return this.transporter;
  }

  private hashCreds(...parts: (string | undefined)[]): string {
    return parts.map((p) => p ?? '').join('|');
  }

  // ── Public methods ───────────────────────────────────────────────

  /**
   * Brand-level defaults injected into every email template.
   * Individual template data can override these.
   */
  private async getBrandDefaults(): Promise<Record<string, string>> {
    const brandName = (await settings.get('BRAND_NAME')) ?? env.BRAND_NAME ?? 'SBEK';
    const brandWebsite = (await settings.get('BRAND_WEBSITE')) ?? env.BRAND_WEBSITE ?? '';
    const supportPhone = (await settings.get('BRAND_SUPPORT_PHONE')) ?? env.BRAND_SUPPORT_PHONE ?? '';
    const supportEmail = (await settings.get('BRAND_SUPPORT_EMAIL')) ?? env.BRAND_SUPPORT_EMAIL ?? '';
    const reviewUrl = (await settings.get('REVIEW_URL')) ?? env.REVIEW_URL ?? '';

    return {
      brand_name: brandName,
      brand_website: brandWebsite,
      support_phone: supportPhone,
      support_email: supportEmail,
      instagram_url: brandWebsite ? `${brandWebsite}/instagram` : 'https://instagram.com/sbek.jewelry',
      facebook_url: brandWebsite ? `${brandWebsite}/facebook` : 'https://facebook.com/sbekjewelry',
      pinterest_url: brandWebsite ? `${brandWebsite}/pinterest` : 'https://pinterest.com/sbekjewelry',
      unsubscribe_url: brandWebsite ? `${brandWebsite}/unsubscribe` : '#',
      review_url: reviewUrl,
    };
  }

  /**
   * Check if Gmail API OAuth credentials are available.
   */
  private async hasGmailApi(): Promise<boolean> {
    const clientId = (await settings.get('GOOGLE_OAUTH_CLIENT_ID')) ?? env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = (await settings.get('GOOGLE_OAUTH_CLIENT_SECRET')) ?? env.GOOGLE_OAUTH_CLIENT_SECRET;
    const refreshToken = (await settings.get('GOOGLE_OAUTH_REFRESH_TOKEN')) ?? env.GOOGLE_OAUTH_REFRESH_TOKEN;
    return !!(clientId && clientSecret && refreshToken);
  }

  /**
   * Send an email via Gmail API (HTTPS, works on Railway/hosts that block SMTP ports).
   */
  private async sendViaGmailApi(
    to: string,
    subject: string,
    html: string,
    emailFrom: string | undefined,
  ): Promise<string> {
    const clientId = (await settings.get('GOOGLE_OAUTH_CLIENT_ID')) ?? env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = (await settings.get('GOOGLE_OAUTH_CLIENT_SECRET')) ?? env.GOOGLE_OAUTH_CLIENT_SECRET;
    const refreshToken = (await settings.get('GOOGLE_OAUTH_REFRESH_TOKEN')) ?? env.GOOGLE_OAUTH_REFRESH_TOKEN;

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const from = emailFrom || `SBEK <${(await settings.get('SMTP_USER')) ?? env.SMTP_USER}>`;
    // RFC 2047 encode subject to handle non-ASCII characters (emojis, accents, etc.)
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
    const messageParts = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
    ];
    const rawMessage = Buffer.from(messageParts.join('\r\n')).toString('base64url');

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: rawMessage },
    });

    return result.data.id ?? 'unknown';
  }

  /**
   * Core send method: tries Gmail API first, falls back to SMTP.
   */
  private async send(to: string, subject: string, html: string): Promise<void> {
    const emailFrom = (await settings.get('EMAIL_FROM')) ?? env.EMAIL_FROM;

    // Try Gmail API first (works on Railway and other hosts that block SMTP)
    if (await this.hasGmailApi()) {
      try {
        const messageId = await this.sendViaGmailApi(to, subject, html, emailFrom);
        logger.info({ to, subject, messageId, via: 'gmail-api' }, 'Email sent via Gmail API');
        return;
      } catch (error) {
        logger.warn({ to, subject, error }, 'Gmail API failed, falling back to SMTP');
      }
    }

    // Fallback: SMTP
    const transporter = await this.getTransporter();
    const info = await transporter.sendMail({
      from: emailFrom,
      to,
      subject,
      html,
    });
    logger.info({ to, subject, messageId: info.messageId, via: 'smtp' }, 'Email sent via SMTP');
  }

  /**
   * Send an email rendered from a pre-compiled Handlebars template.
   */
  async sendEmail(
    to: string,
    subject: string,
    templateName: string,
    data: Record<string, string>,
  ): Promise<void> {
    const template = this.getTemplate(templateName);
    const brandDefaults = await this.getBrandDefaults();
    const html = template({ ...brandDefaults, ...data });

    try {
      await this.send(to, subject, html);
    } catch (error) {
      logger.error({ to, subject, templateName, error }, 'Failed to send email');
      throw error;
    }
  }

  /**
   * Send an email with raw HTML content (no template).
   */
  async sendRawHtml(
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    try {
      await this.send(to, subject, html);
    } catch (error) {
      logger.error({ to, subject, error }, 'Failed to send raw HTML email');
      throw error;
    }
  }

  /**
   * Verify the email connection (Gmail API or SMTP).
   */
  async verifyConnection(): Promise<{ ok: boolean; via: string }> {
    // Try Gmail API first
    if (await this.hasGmailApi()) {
      try {
        const clientId = (await settings.get('GOOGLE_OAUTH_CLIENT_ID')) ?? env.GOOGLE_OAUTH_CLIENT_ID;
        const clientSecret = (await settings.get('GOOGLE_OAUTH_CLIENT_SECRET')) ?? env.GOOGLE_OAUTH_CLIENT_SECRET;
        const refreshToken = (await settings.get('GOOGLE_OAUTH_REFRESH_TOKEN')) ?? env.GOOGLE_OAUTH_REFRESH_TOKEN;

        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        const { token } = await oauth2Client.getAccessToken();
        if (!token) throw new Error('Failed to obtain access token');
        logger.info('Gmail API connection verified');
        return { ok: true, via: 'gmail-api' };
      } catch (error) {
        logger.error({ error }, 'Gmail API verification failed');
        return { ok: false, via: 'gmail-api' };
      }
    }

    // Fallback: SMTP
    try {
      const transporter = await this.getTransporter();
      await transporter.verify();
      logger.info('SMTP connection verified');
      return { ok: true, via: 'smtp' };
    } catch (error) {
      logger.error({ error }, 'SMTP connection verification failed');
      return { ok: false, via: 'smtp' };
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Read and compile all .hbs files from the templates/email/ directory
   * at startup. Templates are stored in a Map keyed by filename (without
   * the .hbs extension).
   */
  private loadTemplates(): void {
    const templateDir = resolve(__dirname, '../templates/email');

    let files: string[];
    try {
      files = readdirSync(templateDir).filter((f) => f.endsWith('.hbs'));
    } catch {
      logger.warn(
        { templateDir },
        'Email template directory not found — no templates loaded',
      );
      return;
    }

    for (const file of files) {
      const name = basename(file, '.hbs');
      const source = readFileSync(resolve(templateDir, file), 'utf-8');
      this.templates.set(name, Handlebars.compile(source));
    }

    logger.info(
      { count: this.templates.size },
      'Email templates compiled',
    );
  }

  /**
   * Retrieve a compiled template by name or throw if it does not exist.
   * Supports lookup by exact name or by normalizing underscores → hyphens
   * (e.g. "order_confirmation" -> "order-confirmation", "review_request" -> "review-request").
   */
  private getTemplate(name: string): HandlebarsTemplateDelegate {
    let template = this.templates.get(name);

    // Fallback: convert underscores to hyphens (template files use hyphens)
    if (!template) {
      template = this.templates.get(name.replace(/_/g, '-'));
    }

    // Fallback: strip "order_" prefix to match file names like shipped.hbs
    if (!template && name.startsWith('order_')) {
      template = this.templates.get(name.replace('order_', ''));
    }

    if (!template) {
      throw new Error(
        `Email template "${name}" not found. Available: ${[...this.templates.keys()].join(', ') || '(none)'}`,
      );
    }
    return template;
  }
}

export const email = new EmailService();
