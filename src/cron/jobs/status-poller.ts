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

  // Match on TARGET status — works regardless of which status it came from.
  // e.g. "New → QC" or "In Production → QC" both trigger QC actions.
  switch (newStatus) {
    // ── → In Production ─────────────────────────────────────────────
    case 'In Production': {
      await createProductionTask({
        orderId: numericId,
        status: 'in_production',
        assignee: order['Production Assignee'] || undefined,
        notes: order['Notes'] || undefined,
      });
      break;
    }

    // ── → QC ────────────────────────────────────────────────────────
    case 'QC': {
      // Mark production as completed (if it exists)
      await completeProduction(numericId).catch((err) => {
        logger.warn({ err, orderId }, 'completeProduction skipped (may not have production row)');
      });
      await createQCChecklist({
        orderId: numericId,
        productName: order['Product'] || '',
        checklistItems: [],
      });
      break;
    }

    // ── → Ready to Ship ─────────────────────────────────────────────
    case 'Ready to Ship': {
      const phone = order['Phone'] ? normalizePhone(order['Phone']) : undefined;
      const email = order['Email'] || undefined;

      if (phone || email) {
        await notification.add(`poller-qc-passed-${orderId}`, {
          channel: 'both',
          recipientPhone: phone,
          recipientEmail: email,
          recipientName: order['Customer Name'] || 'Customer',
          templateName: 'qc_passed',
          templateData: {
            customer_name: order['Customer Name'] || 'Customer',
            order_id: orderId,
            product_name: order['Product'] || '',
          },
        }, { jobId: `notify-qc-passed-${orderId}` });
      }

      await sheets.updateOrder(orderId, {
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
        customerName: order['Customer Name'] || 'Customer',
        customerPhone: order['Phone'] || undefined,
        customerEmail: order['Email'] || undefined,
        productName: order['Product'] || '',
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
        customerName: order['Customer Name'] || 'Customer',
        customerPhone: order['Phone'] || undefined,
        customerEmail: order['Email'] || undefined,
        productName: order['Product'] || '',
      });

      await sheets.updateOrder(orderId, {
        'Last Updated': formatDate(new Date()),
      });
      break;
    }

    default:
      logger.warn(
        { orderId, from: oldStatus, to: newStatus },
        'Status poller: unhandled target status',
      );
  }
}
