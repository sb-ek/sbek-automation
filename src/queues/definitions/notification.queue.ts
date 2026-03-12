import { Worker, type Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { NotificationPayload } from '../types.js';
import { whatsapp } from '../../services/whatsapp.service.js';
import { email } from '../../services/email.service.js';
import { logJobActive, logJobCompleted, logJobFailed } from '../job-logger.js';
import { db } from '../../config/database.js';
import { notificationLogs } from '../../db/schema.js';

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
 * Notification Worker — fan-out dispatcher for WhatsApp (AiSensy) and Email.
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
        try {
          await db.insert(notificationLogs).values({
            orderId: job.data.orderId ?? null,
            recipientName: safeName,
            recipientEmail,
            recipientPhone: recipientPhone ?? null,
            channel: 'email',
            templateName,
            status: 'sent',
          });
        } catch (logErr) {
          logger.warn({ err: logErr }, 'Failed to log email notification');
        }
      } catch (err) {
        logger.error({ err, recipientEmail, templateName }, 'Email failed');
        results.email = 'failed';
        try {
          await db.insert(notificationLogs).values({
            orderId: job.data.orderId ?? null,
            recipientName: safeName,
            recipientEmail,
            recipientPhone: recipientPhone ?? null,
            channel: 'email',
            templateName,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        } catch (logErr) {
          logger.warn({ err: logErr }, 'Failed to log email notification failure');
        }
      }
    }

    // WhatsApp via AiSensy
    if ((channel === 'whatsapp' || channel === 'both') && recipientPhone) {
      const configured = await whatsapp.isConfigured();
      if (!configured) {
        logger.warn({ recipientPhone, templateName }, 'WhatsApp (AiSensy) not configured — skipping');
        results.whatsapp = 'not_configured';
      } else {
        try {
          const msgId = await whatsapp.sendTemplate(recipientPhone, templateName, templateData);
          results.whatsapp = msgId;
          logger.info({ recipientPhone, templateName, msgId }, 'WhatsApp sent via AiSensy');
          try {
            await db.insert(notificationLogs).values({
              orderId: job.data.orderId ?? null,
              recipientName: safeName,
              recipientEmail: recipientEmail ?? null,
              recipientPhone,
              channel: 'whatsapp',
              templateName,
              status: 'sent',
            });
          } catch (logErr) {
            logger.warn({ err: logErr }, 'Failed to log WhatsApp notification');
          }
        } catch (err) {
          logger.error({ err, recipientPhone, templateName }, 'WhatsApp (AiSensy) failed');
          results.whatsapp = 'failed';
          try {
            await db.insert(notificationLogs).values({
              orderId: job.data.orderId ?? null,
              recipientName: safeName,
              recipientEmail: recipientEmail ?? null,
              recipientPhone,
              channel: 'whatsapp',
              templateName,
              status: 'failed',
              error: err instanceof Error ? err.message : String(err),
            });
          } catch (logErr) {
            logger.warn({ err: logErr }, 'Failed to log WhatsApp notification failure');
          }
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
  'order_confirmation': 'SBEK Order Confirmed — ARKA Has Received Your Request',
  'production_started': 'SBEK Update — ARKA Has Begun Crafting Your Pendant',
  'qc_started': 'SBEK Update — Final Details Are Being Prepared',
  'qc_passed': 'SBEK Update — ARKA Is Inspecting Your Pendant',
  'final_assembly': 'SBEK Update — Your Pendant Is Being Completed',
  'piece_ready': 'SBEK Update — Your Pendant Is Ready',
  'order_shipped': 'SBEK Update — Your Pendant Has Been Shipped',
  'shipped': 'SBEK Update — Your Pendant Has Been Shipped',
  'delivered': 'SBEK Delivery Confirmation — Your Pendant Has Arrived',
  'order_delivered': 'SBEK Delivery Confirmation — Your Pendant Has Arrived',
  'review_request': 'SBEK — Your Journey With ARKA Continues',
  'production_brief': 'SBEK Production Brief - New Order Assignment',
  'qc_failed_alert': 'SBEK QC Alert - Rework Required',
  'competitor_alert': 'SBEK Competitor Intelligence Report',
  'price_alert': 'SBEK Price Alert — Competitor Price Changes',
};

notificationWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, template: job.data.templateName }, 'Notification job completed');
  logJobCompleted('notification', job);
});

notificationWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Notification job failed');
  logJobFailed('notification', job, err);
});
