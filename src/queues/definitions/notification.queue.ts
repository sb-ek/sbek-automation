import { Worker, type Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { NotificationPayload } from '../types.js';
import { whatsapp } from '../../services/whatsapp.service.js';
import { wati } from '../../services/wati.service.js';
import { email } from '../../services/email.service.js';
import { logJobActive, logJobCompleted, logJobFailed } from '../job-logger.js';

function redisOpts() {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    maxRetriesPerRequest: null as null,
  };
}

/**
 * Notification Worker — fan-out dispatcher for WhatsApp and Email.
 * Workflows enqueue jobs with channel: 'whatsapp' | 'email' | 'both'.
 */
export const notificationWorker = new Worker<NotificationPayload>(
  'notification',
  async (job: Job<NotificationPayload>) => {
    logJobActive('notification', job);
    const { channel, recipientPhone, recipientEmail, recipientName, templateName, templateData } = job.data;
    const safeName = recipientName || 'Valued Customer';

    const results: Record<string, string> = {};

    // Email (send first — most reliable channel)
    if ((channel === 'email' || channel === 'both') && recipientEmail) {
      try {
        const subject = emailSubjects[templateName] || `SBEK — Update on your order`;
        await email.sendEmail(recipientEmail, subject, templateName, {
          ...templateData,
          customer_name: safeName,
        });
        results.email = 'sent';
        logger.info({ recipientEmail, templateName }, 'Email sent');
      } catch (err) {
        logger.error({ err, recipientEmail, templateName }, 'Email failed');
        results.email = 'failed';
      }
    }

    // WhatsApp (best-effort — don't block job if unconfigured)
    if ((channel === 'whatsapp' || channel === 'both') && recipientPhone) {
      try {
        const msgId = await whatsapp.sendTemplate(
          recipientPhone,
          templateName,
          'en',
          [
            {
              type: 'body',
              parameters: Object.values(templateData).map((val) => ({ type: 'text' as const, text: val })),
            },
          ]
        );
        results.whatsapp = msgId;
        logger.info({ recipientPhone, templateName, msgId }, 'WhatsApp sent via Meta');
      } catch (metaErr) {
        logger.warn({ err: metaErr, recipientPhone, templateName }, 'Meta WhatsApp failed — trying backup');

        if (wati.isConfigured()) {
          try {
            const backup = await wati.sendTemplate(recipientPhone, templateName, templateData);
            results.whatsapp = `${backup.provider}:${backup.messageId}`;
            logger.info({ recipientPhone, templateName, provider: backup.provider }, 'WhatsApp sent via backup');
          } catch (backupErr) {
            logger.error({ err: backupErr, recipientPhone, templateName }, 'All WhatsApp providers failed');
            results.whatsapp = 'failed';
          }
        } else {
          logger.warn({ recipientPhone, templateName }, 'WhatsApp not configured — skipping');
          results.whatsapp = 'not_configured';
        }
      }
    }

    return results;
  },
  {
    connection: redisOpts(),
    concurrency: 5,
    limiter: {
      max: 20,
      duration: 60_000,
    },
  }
);

/** Map template names to email subject lines */
const emailSubjects: Record<string, string> = {
  'order_confirmation': 'Thank you for your SBEK order!',
  'production_started': 'Your SBEK piece is being crafted',
  'qc_started': 'Your SBEK piece is in quality check',
  'qc_passed': 'Your SBEK order passed quality check!',
  'order_shipped': 'Your SBEK order is on its way!',
  'shipped': 'Your SBEK order is on its way!',
  'delivered': 'Your SBEK order has been delivered',
  'order_delivered': 'Your SBEK order has been delivered',
  'review_request': "We'd love your feedback on your SBEK purchase",
  'production_brief': 'SBEK Production Brief - New Order Assignment',
  'qc_failed_alert': 'SBEK QC Alert - Rework Required',
  'competitor_alert': 'SBEK Competitor Intelligence Report',
};

notificationWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, template: job.data.templateName }, 'Notification job completed');
  logJobCompleted('notification', job);
});

notificationWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Notification job failed');
  logJobFailed('notification', job, err);
});
