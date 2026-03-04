import { logger } from '../config/logger.js';
import { notification } from '../queues/registry.js';
import { env } from '../config/env.js';
import type { ReviewRequestPayload } from '../queues/types.js';

/**
 * Review Collection Workflow
 *
 * Sends a review request to the customer 5 days after delivery.
 * Triggered by the delayed review-request queue job.
 */
export async function sendReviewRequest(payload: ReviewRequestPayload): Promise<void> {
  const { orderId, customerName, customerEmail, customerPhone, productName } = payload;

  logger.info({ orderId, customerName }, 'Sending review request');

  const reviewUrl = env.REVIEW_URL || env.BRAND_WEBSITE || '#';

  await notification.add(`review-notify-${orderId}`, {
    channel: 'both',
    recipientPhone: customerPhone || undefined,
    recipientEmail: customerEmail || undefined,
    recipientName: customerName,
    templateName: 'review_request',
    templateData: {
      customer_name: customerName,
      order_id: String(orderId),
      product_name: productName,
      review_url: reviewUrl,
    },
    orderId,
  }, { jobId: `notify-review-${orderId}` });

  logger.info({ orderId }, 'Review request sent');
}
