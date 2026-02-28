import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { sheets } from '../services/googlesheets.service.js';
import { notification } from '../queues/registry.js';
import type { ProductionUpdatePayload } from '../queues/types.js';
import { formatDate, subtractDays } from '../utils/date.js';

/**
 * Production Tracking Workflow
 *
 * Creates production task rows when an order enters "In Production" status.
 * Assigns work based on product type -> team member mapping from Config.
 * Sends internal WhatsApp briefs to assigned craftsperson.
 */
export async function createProductionTask(payload: ProductionUpdatePayload): Promise<void> {
  const { orderId, assignee, notes } = payload;

  logger.info({ orderId }, 'Creating production task');

  // Get order details from Sheets
  const orders = await sheets.getOrdersByStatus('New');
  const order = orders?.find((row) => row['Order ID'] === String(orderId));

  if (!order) {
    logger.warn({ orderId }, 'Order not found in Sheets for production task creation');
    return;
  }

  const promisedDelivery = order['Promised Delivery'];
  const dueDate = promisedDelivery
    ? formatDate(subtractDays(new Date(promisedDelivery), 2))
    : formatDate(subtractDays(new Date(), -14)); // default 14 days from now

  const productionData = {
    'Order ID': String(orderId),
    'Product': order['Product'] || '',
    'Customer': order['Customer Name'] || '',
    'Ring Size': order['Size'] || '',
    'Metal Type': order['Metal'] || '',
    'Stones': order['Stones'] || '',
    'Engraving Text': order['Engraving'] || '',
    'Reference Image URL': '',
    'Assigned To': assignee || 'Unassigned',
    'Due Date': dueDate,
    'Started Date': formatDate(new Date()),
    'Completed Date': '',
    'Status': 'In Progress',
    'Notes': notes || '',
  };

  await sheets.appendProductionTask(productionData);

  // Update order status in Orders tab
  await sheets.updateOrder(String(orderId), {
    'Status': 'In Production',
    'Production Assignee': assignee || 'Unassigned',
    'Last Updated': formatDate(new Date()),
  });

  // Send internal WhatsApp brief to assigned craftsperson (if phone is configured)
  const adminPhone = env.BRAND_SUPPORT_PHONE;
  if (assignee && adminPhone) {
    await notification.add(`production-brief-${orderId}`, {
      channel: 'whatsapp',
      recipientPhone: adminPhone,
      recipientName: assignee,
      templateName: 'production_brief',
      templateData: {
        order_id: String(orderId),
        product_name: order['Product'] || '',
        customer_name: order['Customer Name'] || '',
        ring_size: order['Size'] || 'N/A',
        metal_type: order['Metal'] || 'N/A',
        engraving: order['Engraving'] || 'None',
        due_date: dueDate,
      },
    });
  }

  // Send customer notification
  const customerPhone = order['Phone'];
  const customerEmail = order['Email'];

  if (customerPhone || customerEmail) {
    await notification.add(`notify-production-${orderId}`, {
      channel: 'both',
      recipientPhone: customerPhone || undefined,
      recipientEmail: customerEmail || undefined,
      recipientName: order['Customer Name'] || 'Customer',
      templateName: 'production_started',
      templateData: {
        customer_name: order['Customer Name'] || 'Customer',
        order_id: String(orderId),
        product_name: order['Product'] || '',
      },
    });
  }

  logger.info({ orderId, assignee }, 'Production task created');
}

/**
 * Mark production as completed -- triggers QC workflow.
 */
export async function completeProduction(orderId: number): Promise<void> {
  await sheets.updateProductionStatus(String(orderId), 'Completed', {
    'Completed Date': formatDate(new Date()),
  });

  await sheets.updateOrder(String(orderId), {
    'Status': 'QC',
    'Last Updated': formatDate(new Date()),
  });

  logger.info({ orderId }, 'Production completed, moving to QC');
}
