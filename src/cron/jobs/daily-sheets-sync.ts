import { logger } from '../../config/logger.js';
import { woocommerce } from '../../services/woocommerce.service.js';
import { orderSync } from '../../queues/registry.js';

const MAX_PAGES = 20; // Safety cap to prevent infinite pagination

/**
 * Daily cron: full reconciliation sync.
 * Pulls recent orders from WooCommerce and enqueues sync jobs
 * to ensure Sheets stays in sync even if webhooks were missed.
 */
export async function runDailySheetsSync(): Promise<void> {
  let page = 1;
  let enqueued = 0;

  // Sync orders from the last 3 days to catch any missed webhooks
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  try {
    while (page <= MAX_PAGES) {
      const orders = await woocommerce.listOrders({
        per_page: 50,
        page,
        after: threeDaysAgo.toISOString(),
      });

      if (!orders || orders.length === 0) break;

      for (const order of orders) {
        await orderSync.add(`sync-${order.id}`, {
          orderId: order.id,
          event: 'order.updated',
          rawPayload: order as unknown as Record<string, unknown>,
        }, { jobId: `daily-sync-${order.id}` });
        enqueued++;
      }

      if (orders.length < 50) break;
      page++;
    }

    if (page > MAX_PAGES) {
      logger.warn({ maxPages: MAX_PAGES }, 'Daily sync hit page limit — some orders may not have been synced');
    }
  } catch (err) {
    logger.error({ err }, 'Daily sheets sync failed during fetch');
    throw err;
  }

  logger.info({ enqueued, pages: page }, 'Daily sheets sync completed');
}
