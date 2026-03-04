import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { sheets } from '../services/googlesheets.service.js';
import { notification } from '../queues/registry.js';
import type { QCCheckPayload } from '../queues/types.js';
import { formatDate } from '../utils/date.js';

/** Default QC checklist items for jewelry */
const DEFAULT_CHECKLIST = [
  'Dimensions match order specs',
  'Metal finish quality',
  'Stone setting secure',
  'Engraving accuracy',
  'Surface polish',
  'Packaging condition',
];

/**
 * QC Tracking Workflow
 *
 * Triggered when production status changes to "Completed".
 * Creates QC checklist rows and handles pass/fail logic.
 */
export async function createQCChecklist(payload: QCCheckPayload): Promise<void> {
  const { orderId, productName, checklistItems } = payload;

  // Prevent duplicate QC checklists for the same order
  const existingItems = await sheets.getQCItems(String(orderId));
  if (existingItems && existingItems.length > 0) {
    logger.info({ orderId, existingCount: existingItems.length }, 'QC checklist already exists, skipping');
    return;
  }

  const items = checklistItems.length > 0 ? checklistItems : DEFAULT_CHECKLIST;

  logger.info({ orderId, itemCount: items.length }, 'Creating QC checklist');

  const qcRows = items.map((item) => ({
    'Order ID': String(orderId),
    'Product': productName,
    'QC Date': formatDate(new Date()),
    'Checklist Item': item,
    'Pass/Fail': 'Pending',
    'Photo URL': '',
    'Inspector': '',
    'Notes': '',
    'Action Taken': '',
  }));

  await sheets.appendQCItems(qcRows);

  logger.info({ orderId }, 'QC checklist created');
}

/**
 * Evaluate QC results for an order.
 * If all items pass -> update status to "Shipped" ready state, notify customer.
 * If any item fails -> send alert, create rework task.
 */
export async function evaluateQCResults(orderId: number): Promise<'passed' | 'failed'> {
  const items = await sheets.getQCItems(String(orderId));

  if (!items || items.length === 0) {
    logger.warn({ orderId }, 'No QC items found');
    return 'failed';
  }

  const allPassed = items.every((row) => row['Pass/Fail'] === 'Pass');
  const anyFailed = items.some((row) => row['Pass/Fail'] === 'Fail');

  if (allPassed) {
    // QC passed -- advance order to Ready to Ship and notify customer
    await sheets.updateOrder(String(orderId), {
      'Status': 'Ready to Ship',
      'Notes': 'QC Passed - Ready for dispatch',
      'Last Updated': formatDate(new Date()),
    });

    // Get order details for notification
    const orders = await sheets.getOrdersByStatus('Ready to Ship');
    const order = orders?.find((row) => row['Order ID'] === String(orderId));

    if (order) {
      const customerPhone = order['Phone'];
      const customerEmail = order['Email'];

      if (customerPhone || customerEmail) {
        // Calculate estimated ship date (2 business days from now)
        const shipDate = new Date();
        shipDate.setDate(shipDate.getDate() + 2);
        if (shipDate.getDay() === 0) shipDate.setDate(shipDate.getDate() + 1);

        await notification.add(`notify-qc-passed-${orderId}`, {
          channel: 'both',
          recipientPhone: customerPhone || undefined,
          recipientEmail: customerEmail || undefined,
          recipientName: order['Customer Name'] || 'Customer',
          templateName: 'qc_passed',
          templateData: {
            customer_name: order['Customer Name'] || 'Customer',
            order_id: String(orderId),
            product_name: order['Product'] || '',
            ship_date: formatDate(shipDate),
          },
        });
      }
    }

    logger.info({ orderId }, 'QC passed');
    return 'passed';
  }

  if (anyFailed) {
    // QC failed -- send alert to production team, create rework
    const failedItems = items
      .filter((row) => row['Pass/Fail'] === 'Fail')
      .map((row) => row['Checklist Item'])
      .join(', ');

    await sheets.updateOrder(String(orderId), {
      'Status': 'In Production',
      'Notes': `QC Failed - Rework needed: ${failedItems}`,
      'Last Updated': formatDate(new Date()),
    });

    // Reset production status for rework
    await sheets.updateProductionStatus(String(orderId), 'Rework', {
      'Notes': `QC Failed: ${failedItems}`,
      'Started Date': formatDate(new Date()),
      'Completed Date': '',
    });

    // Send internal alert
    const adminPhone = env.BRAND_SUPPORT_PHONE;
    if (!adminPhone) {
      logger.warn({ orderId }, 'No BRAND_SUPPORT_PHONE configured — skipping QC failure WhatsApp alert');
    }
    await notification.add(`qc-failed-alert-${orderId}`, {
      channel: 'whatsapp',
      recipientPhone: adminPhone || undefined,
      recipientName: 'Production Team',
      templateName: 'qc_failed_alert',
      templateData: {
        order_id: String(orderId),
        failed_items: failedItems,
      },
    });

    logger.info({ orderId, failedItems }, 'QC failed -- rework initiated');
    return 'failed';
  }

  // Some items still pending
  logger.info({ orderId }, 'QC evaluation: some items still pending');
  return 'failed';
}
