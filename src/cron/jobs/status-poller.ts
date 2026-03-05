import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';
import { sheets } from '../../services/googlesheets.service.js';
import { createProductionTask } from '../../workflows/production-tracking.workflow.js';
import { completeProduction } from '../../workflows/production-tracking.workflow.js';
import { createQCChecklist } from '../../workflows/qc-tracking.workflow.js';
import { handleStatusChange } from '../../workflows/customer-comms.workflow.js';
import { notification } from '../../queues/registry.js';
import { normalizePhone } from '../../utils/sanitize.js';
import { formatDate } from '../../utils/date.js';
import { db } from '../../config/database.js';
import { webhookEvents } from '../../db/schema.js';

// ── In-memory snapshot: Order ID → last-known status ─────────────────────
// Resets on process restart — first poll re-seeds without triggering actions.
const statusSnapshot = new Map<string, string>();
let initialized = false;

const LOCK_KEY = 'sbek:status-poller:lock';
const LOCK_TTL = 120; // seconds — must be longer than a poll cycle

// ── Public entry point (called by scheduler) ─────────────────────────────

export async function runStatusPoller(): Promise<void> {
  // Distributed lock via Redis SETNX — safe across restarts and multiple instances
  const acquired = await redis.set(LOCK_KEY, Date.now().toString(), 'EX', LOCK_TTL, 'NX');
  if (acquired !== 'OK') {
    logger.debug('Status poller: lock held by another cycle, skipping');
    return;
  }

  try {
    await sheets.init();
    const allOrders = await sheets.getAllOrders();

    if (!allOrders || allOrders.length === 0) {
      logger.debug('Status poller: no orders found');
      return;
    }

    // First run: seed snapshot without triggering actions
    if (!initialized) {
      for (const order of allOrders) {
        const orderId = order['Order ID'];
        const status = order['Status'];
        if (orderId && status) {
          statusSnapshot.set(orderId, status);
        }
      }
      initialized = true;
      logger.info({ orderCount: statusSnapshot.size }, 'Status poller: snapshot seeded');
      return;
    }

    // Subsequent runs: detect changes
    const currentIds = new Set<string>();
    let changesDetected = 0;

    for (const order of allOrders) {
      const orderId = order['Order ID'];
      const currentStatus = order['Status'];
      if (!orderId || !currentStatus) continue;

      currentIds.add(orderId);
      const previousStatus = statusSnapshot.get(orderId);

      // New order appeared since last poll
      if (previousStatus === undefined) {
        statusSnapshot.set(orderId, currentStatus);
        // If the order already has a non-"New" status, dispatch the transition
        // so production tasks, notifications, etc. still fire
        if (currentStatus && currentStatus !== 'New') {
          try {
            logger.info(
              { orderId, status: currentStatus },
              'Status poller: new order with non-New status — dispatching',
            );
            await dispatchTransition(orderId, 'New', currentStatus, order);
            changesDetected++;
          } catch (err) {
            logger.error(
              { err, orderId, status: currentStatus },
              'Status poller: dispatch error for new order',
            );
          }
        }
        continue;
      }

      // No change
      if (previousStatus === currentStatus) continue;

      // Status changed — dispatch
      logger.info(
        { orderId, from: previousStatus, to: currentStatus },
        'Status poller: change detected',
      );

      try {
        await dispatchTransition(orderId, previousStatus, currentStatus, order);
        changesDetected++;
        // Only update snapshot on success
        statusSnapshot.set(orderId, currentStatus);
      } catch (err) {
        logger.error(
          { err, orderId, from: previousStatus, to: currentStatus },
          'Status poller: transition error — will retry next cycle',
        );
        // Don't update snapshot so transition retries on next poll
      }
    }

    // Cleanup deleted orders
    for (const id of statusSnapshot.keys()) {
      if (!currentIds.has(id)) statusSnapshot.delete(id);
    }

    if (changesDetected > 0) {
      logger.info({ changesDetected }, 'Status poller: cycle complete');
    }
  } finally {
    await redis.del(LOCK_KEY).catch(() => {});
  }
}

// ── Transition dispatcher ────────────────────────────────────────────────

async function dispatchTransition(
  orderId: string,
  oldStatus: string,
  newStatus: string,
  order: Record<string, string>,
): Promise<void> {
  const numericId = Number(orderId);

  // Audit trail
  await sheets.logEvent(
    'INFO',
    'StatusPoller',
    `Order ${orderId}: ${oldStatus} → ${newStatus}`,
    JSON.stringify({ customer: order['Customer Name'], product: order['Product'] }),
  ).catch((err) => { logger.warn({ err }, 'Failed to log status change to Sheets'); });

  // Log to webhook_events for dashboard activity feed
  await db.insert(webhookEvents).values({
    source: 'sheets-poller',
    event: `status.${newStatus.toLowerCase().replace(/\s+/g, '_')}`,
    payload: { orderId, from: oldStatus, to: newStatus, customer: order['Customer Name'] },
    processed: true,
    processedAt: new Date(),
  }).catch((err) => { logger.warn({ err }, 'Failed to log status change to DB'); });

  // Common data for notifications
  const phone = order['Phone'] ? normalizePhone(order['Phone']) : undefined;
  const email = order['Email'] || undefined;
  const customerName = order['Customer Name'] || 'Customer';
  const productName = order['Product'] || '';
  const hasRecipient = !!(phone || email);

  // Match on TARGET status — works regardless of which status it came from.
  switch (newStatus) {
    // ── → In Production ─────────────────────────────────────────────
    case 'In Production': {
      // Create production task row + auto-assign team
      await createProductionTask({
        orderId: numericId,
        status: 'in_production',
        assignee: order['Production Assignee'] || undefined,
        notes: order['Notes'] || undefined,
      });
      // createProductionTask already sends customer email + updates sheet
      break;
    }

    // ── → QC ────────────────────────────────────────────────────────
    case 'QC': {
      // Mark production as completed
      await completeProduction(numericId).catch((err) => {
        logger.warn({ err, orderId }, 'completeProduction skipped (may not have production row)');
      });

      // Create QC checklist in QC tab
      await createQCChecklist({
        orderId: numericId,
        productName,
        checklistItems: [],
      });

      // Notify customer that QC has started
      if (hasRecipient) {
        await notification.add(`poller-qc-started-${orderId}`, {
          channel: 'email',
          recipientPhone: phone,
          recipientEmail: email,
          recipientName: customerName,
          templateName: 'qc_started',
          templateData: {
            customer_name: customerName,
            order_id: orderId,
            product_name: productName,
          },
        }, { jobId: `notify-qc-started-${orderId}` });
      }

      await sheets.updateOrder(orderId, {
        'Last Updated': formatDate(new Date()),
      });
      break;
    }

    // ── → Ready to Ship (QC Passed) ─────────────────────────────────
    case 'Ready to Ship': {
      // Calculate estimated ship date (2 business days from now)
      const shipDate = new Date();
      shipDate.setDate(shipDate.getDate() + 2);
      if (shipDate.getDay() === 0) shipDate.setDate(shipDate.getDate() + 1);

      if (hasRecipient) {
        await notification.add(`poller-qc-passed-${orderId}`, {
          channel: 'both',
          recipientPhone: phone,
          recipientEmail: email,
          recipientName: customerName,
          templateName: 'qc_passed',
          templateData: {
            customer_name: customerName,
            order_id: orderId,
            product_name: productName,
            ship_date: formatDate(shipDate),
          },
        }, { jobId: `notify-qc-passed-${orderId}` });
      }

      await sheets.updateOrder(orderId, {
        'Notes': 'QC Passed - Ready for dispatch',
        'Last Updated': formatDate(new Date()),
      });
      break;
    }

    // ── → Shipped ───────────────────────────────────────────────────
    case 'Shipped': {
      await handleStatusChange({
        orderId: numericId,
        oldStatus,
        newStatus,
        customerName,
        customerPhone: order['Phone'] || undefined,
        customerEmail: email,
        productName,
        trackingNumber: order['Tracking Number'] || undefined,
      });

      await sheets.updateOrder(orderId, {
        'Last Updated': formatDate(new Date()),
      });
      break;
    }

    // ── → Delivered ─────────────────────────────────────────────────
    case 'Delivered': {
      await handleStatusChange({
        orderId: numericId,
        oldStatus,
        newStatus,
        customerName,
        customerPhone: order['Phone'] || undefined,
        customerEmail: email,
        productName,
      });

      await sheets.updateOrder(orderId, {
        'Last Updated': formatDate(new Date()),
      });
      break;
    }

    // ── → Cancelled / Refunded ──────────────────────────────────────
    case 'Cancelled':
    case 'Refunded': {
      await sheets.updateOrder(orderId, {
        'Last Updated': formatDate(new Date()),
      });
      logger.info({ orderId, newStatus }, 'Order cancelled/refunded — no customer email');
      break;
    }

    default:
      logger.warn(
        { orderId, from: oldStatus, to: newStatus },
        'Status poller: unhandled target status',
      );
  }
}
