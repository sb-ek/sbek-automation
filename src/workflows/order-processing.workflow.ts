import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { woocommerce } from '../services/woocommerce.service.js';
import { sheets } from '../services/googlesheets.service.js';
import { notification } from '../queues/registry.js';
import type { OrderSyncPayload } from '../queues/types.js';
import { formatDate, addDays } from '../utils/date.js';
import { normalizePhone } from '../utils/sanitize.js';

/**
 * Parse the serialized jewelryMeta string to extract individual fields.
 * The jewelryMeta string uses the format: "Ring: 7, Metal: 18K Gold, Stone: Diamond, Engraving: Love"
 * Multiple line items are separated by " | ".
 */
function parseJewelryMetaField(jewelryMeta: string, prefix: string): string {
  if (!jewelryMeta) return '';
  // Collect matches across all line-item segments
  const segments = jewelryMeta.split(' | ');
  const values: string[] = [];
  for (const segment of segments) {
    const parts = segment.split(', ');
    for (const part of parts) {
      if (part.startsWith(`${prefix}: `)) {
        values.push(part.slice(prefix.length + 2));
      }
    }
  }
  return values.join(' | ');
}

/**
 * Order Processing Workflow
 *
 * Triggered by: order-sync queue worker (from WooCommerce webhook)
 *
 * Flow:
 * 1. Parse order data from WooCommerce payload
 * 2. Check if order exists in Google Sheets
 * 3. If new -> add row, send confirmation notifications
 * 4. If existing -> update row, handle status changes
 * 5. Upsert customer record
 */
export async function processOrderSync(payload: OrderSyncPayload): Promise<void> {
  const { orderId, event, rawPayload } = payload;

  logger.info({ orderId, event }, 'Starting order processing workflow');

  // Ensure Google Sheets is initialised (may not be ready if startup init failed)
  await sheets.init();

  // 1. Parse order into a flat row for Sheets
  const parsed = woocommerce.parseOrderForSheets(rawPayload);

  // Derive fields not directly on ParsedOrderRow
  const promisedDelivery = parsed.orderDate
    ? formatDate(addDays(new Date(parsed.orderDate), 14))
    : formatDate(addDays(new Date(), 14));

  const size = parseJewelryMetaField(parsed.jewelryMeta, 'Ring');
  const metal = parseJewelryMetaField(parsed.jewelryMeta, 'Metal');
  const stones = parseJewelryMetaField(parsed.jewelryMeta, 'Stone');
  const engraving = parseJewelryMetaField(parsed.jewelryMeta, 'Engraving');

  const customerId = String((rawPayload as Record<string, unknown>).customer_id ?? '');

  // 2. Check if order already exists
  const existingRow = await sheets.findOrderRow(String(orderId));

  if (!existingRow && event === 'order.created') {
    // 3a. New order -- append to Sheets
    await sheets.appendOrder({
      'Order ID': String(parsed.orderId),
      'Customer Name': parsed.customerName,
      'Phone': parsed.phone,
      'Email': parsed.email,
      'Product': parsed.products,
      'Variant': parsed.variantDetails,
      'Size': size,
      'Metal': metal,
      'Stones': stones,
      'Engraving': engraving,
      'Amount': parsed.amount,
      'Order Date': parsed.orderDate,
      'Promised Delivery': promisedDelivery,
      'Status': 'New',
      'Production Assignee': '',
      'Notes': '',
      'Last Updated': formatDate(new Date()),
    });

    logger.info({ orderId }, 'New order added to Sheets');

    // Send order confirmation notification
    if (parsed.phone || parsed.email) {
      await notification.add(`notify-order-${orderId}`, {
        channel: 'both',
        recipientPhone: parsed.phone ? normalizePhone(parsed.phone) : undefined,
        recipientEmail: parsed.email || undefined,
        recipientName: parsed.customerName,
        templateName: 'order_confirmation',
        templateData: {
          customer_name: parsed.customerName,
          order_id: String(parsed.orderId),
          product_name: parsed.products,
          amount: parsed.amount,
          order_date: parsed.orderDate || formatDate(new Date()),
          delivery_date: promisedDelivery,
          tracking_url: env.BRAND_WEBSITE ? `${env.BRAND_WEBSITE}/my-account/orders/` : '#',
        },
      }, { jobId: `notify-order-confirm-${orderId}` });
    }
  } else if (existingRow) {
    // 3b. Existing order -- update
    await sheets.updateOrder(String(orderId), {
      'Status': mapWooStatusToSheetStatus(parsed.status),
      'Notes': parsed.notes || '',
      'Last Updated': formatDate(new Date()),
    });

    logger.info({ orderId, status: parsed.status }, 'Order updated in Sheets');
  } else {
    // order.updated but we don't have the row yet -- create it
    await sheets.appendOrder({
      'Order ID': String(parsed.orderId),
      'Customer Name': parsed.customerName,
      'Phone': parsed.phone,
      'Email': parsed.email,
      'Product': parsed.products,
      'Variant': parsed.variantDetails,
      'Size': size,
      'Metal': metal,
      'Stones': stones,
      'Engraving': engraving,
      'Amount': parsed.amount,
      'Order Date': parsed.orderDate,
      'Promised Delivery': promisedDelivery,
      'Status': mapWooStatusToSheetStatus(parsed.status),
      'Production Assignee': '',
      'Notes': '',
      'Last Updated': formatDate(new Date()),
    });
  }

  // 4. Upsert customer record with order totals
  if (parsed.email) {
    // Calculate total orders and total spend for this customer
    let totalOrders = 1;
    let totalSpend = parseFloat(parsed.amount) || 0;
    try {
      const allOrders = await sheets.getAllOrders();
      const customerOrders = allOrders.filter(
        (o) => o['Email'] === parsed.email && o['Order ID'] !== String(parsed.orderId),
      );
      totalOrders = customerOrders.length + 1;
      totalSpend = customerOrders.reduce(
        (sum, o) => sum + (parseFloat(o['Amount']) || 0),
        totalSpend,
      );
    } catch (err) {
      logger.warn({ err }, 'Could not calculate customer totals');
    }

    await sheets.upsertCustomer({
      'Customer ID': customerId,
      'Name': parsed.customerName,
      'Email': parsed.email,
      'Phone': parsed.phone,
      'Total Orders': String(totalOrders),
      'Total Spend': String(totalSpend),
      'Last Order Date': parsed.orderDate,
      'Tags': '',
      'Notes': '',
    });
  }

  logger.info({ orderId }, 'Order processing workflow completed');
}

/** Map WooCommerce order status to our Sheet status values */
function mapWooStatusToSheetStatus(wooStatus: string): string {
  const map: Record<string, string> = {
    'pending': 'New',
    'processing': 'New',
    'on-hold': 'New',
    'completed': 'Delivered',
    'cancelled': 'Cancelled',
    'refunded': 'Refunded',
    'failed': 'Failed',
  };
  return map[wooStatus] || 'New';
}
