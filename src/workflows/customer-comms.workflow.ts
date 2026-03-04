import { logger } from '../config/logger.js';
import { notification, reviewRequest } from '../queues/registry.js';
import { normalizePhone } from '../utils/sanitize.js';

/**
 * Customer Communications Workflow
 *
 * Maps order status changes to the appropriate WhatsApp + Email notifications.
 * Called when an order status changes in Google Sheets.
 */

interface StatusChangeEvent {
  orderId: number;
  oldStatus: string;
  newStatus: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  productName: string;
  trackingNumber?: string;
  trackingUrl?: string;
  carrierName?: string;
}

export async function handleStatusChange(event: StatusChangeEvent): Promise<void> {
  const { orderId, newStatus, customerName, customerPhone, customerEmail, productName } = event;

  logger.info({ orderId, newStatus }, 'Processing status change notification');

  const phone = customerPhone ? normalizePhone(customerPhone) : undefined;

  switch (newStatus) {
    case 'In Production':
      await notification.add(`comms-production-${orderId}`, {
        channel: 'both',
        recipientPhone: phone,
        recipientEmail: customerEmail,
        recipientName: customerName,
        templateName: 'production_started',
        templateData: {
          customer_name: customerName,
          order_id: String(orderId),
          product_name: productName,
        },
        orderId,
      }, { jobId: `notify-production-${orderId}` });
      break;

    case 'Shipped':
      await notification.add(`comms-shipped-${orderId}`, {
        channel: 'both',
        recipientPhone: phone,
        recipientEmail: customerEmail,
        recipientName: customerName,
        templateName: 'order_shipped',
        templateData: {
          customer_name: customerName,
          order_id: String(orderId),
          product_name: productName,
          tracking_number: event.trackingNumber || '',
          tracking_url: event.trackingUrl || '',
          carrier_name: event.carrierName || '',
        },
        orderId,
      }, { jobId: `notify-shipped-${orderId}` });
      break;

    case 'Delivered':
      // Send delivery notification
      await notification.add(`comms-delivered-${orderId}`, {
        channel: 'both',
        recipientPhone: phone,
        recipientEmail: customerEmail,
        recipientName: customerName,
        templateName: 'delivered',
        templateData: {
          customer_name: customerName,
          order_id: String(orderId),
          product_name: productName,
        },
        orderId,
      }, { jobId: `notify-delivered-${orderId}` });

      // Schedule review request 5 days later
      if (customerEmail || phone) {
        await reviewRequest.add(
          `review-${orderId}`,
          {
            orderId,
            customerName,
            customerEmail: customerEmail || '',
            customerPhone: phone || '',
            productName,
            deliveredDate: new Date().toISOString(),
          },
          {
            jobId: `review-req-${orderId}`,
            delay: 5 * 24 * 60 * 60 * 1000, // 5 days in ms
          }
        );
        logger.info({ orderId }, 'Review request scheduled for 5 days from now');
      }
      break;

    default:
      logger.debug({ orderId, newStatus }, 'No customer notification for this status');
  }
}
