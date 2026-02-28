import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import Handlebars from 'handlebars';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

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
  private readonly transporter: Transporter;
  private readonly templates = new Map<string, HandlebarsTemplateDelegate>();

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });

    this.loadTemplates();
  }

  // ── Public methods ───────────────────────────────────────────────

  /**
   * Brand-level defaults injected into every email template.
   * Individual template data can override these.
   */
  private getBrandDefaults(): Record<string, string> {
    return {
      brand_name: env.BRAND_NAME || 'SBEK',
      brand_website: env.BRAND_WEBSITE || '',
      support_phone: env.BRAND_SUPPORT_PHONE || '',
      support_email: env.BRAND_SUPPORT_EMAIL || '',
      instagram_url: env.BRAND_WEBSITE ? `${env.BRAND_WEBSITE}/instagram` : 'https://instagram.com/sbek.jewelry',
      facebook_url: env.BRAND_WEBSITE ? `${env.BRAND_WEBSITE}/facebook` : 'https://facebook.com/sbekjewelry',
      pinterest_url: env.BRAND_WEBSITE ? `${env.BRAND_WEBSITE}/pinterest` : 'https://pinterest.com/sbekjewelry',
      unsubscribe_url: env.BRAND_WEBSITE ? `${env.BRAND_WEBSITE}/unsubscribe` : '#',
      review_url: env.REVIEW_URL || '',
    };
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
    const html = template({ ...this.getBrandDefaults(), ...data });

    try {
      const info = await this.transporter.sendMail({
        from: env.EMAIL_FROM,
        to,
        subject,
        html,
      });
      logger.info({ to, subject, messageId: info.messageId }, 'Email sent');
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
      const info = await this.transporter.sendMail({
        from: env.EMAIL_FROM,
        to,
        subject,
        html,
      });
      logger.info({ to, subject, messageId: info.messageId }, 'Raw HTML email sent');
    } catch (error) {
      logger.error({ to, subject, error }, 'Failed to send raw HTML email');
      throw error;
    }
  }

  /**
   * Verify the SMTP connection is working.
   */
  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      logger.info('SMTP connection verified');
      return true;
    } catch (error) {
      logger.error({ error }, 'SMTP connection verification failed');
      return false;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Read and compile all .hbs files from the templates/email/ directory
   * at startup. Templates are stored in a Map keyed by filename (without
   * the .hbs extension).
   */
  private loadTemplates(): void {
    const templateDir = resolve(__dirname, '../../templates/email');

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
   * Supports lookup by exact name or by mapping common aliases
   * (e.g. "order_shipped" -> "shipped").
   */
  private getTemplate(name: string): HandlebarsTemplateDelegate {
    let template = this.templates.get(name);

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
