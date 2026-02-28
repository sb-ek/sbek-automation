import cron from 'node-cron';
import { logger } from '../config/logger.js';
import { runDailyReviewRequests } from './jobs/daily-review-requests.js';
import { runWeeklyCompetitorCrawl } from './jobs/weekly-competitor-crawl.js';
import { runDailySheetsSync } from './jobs/daily-sheets-sync.js';
import { runWeeklyContentGeneration } from './jobs/weekly-content-generation.js';

const IST = { timezone: 'Asia/Kolkata' };

/**
 * Initialize all cron jobs. Call once at app startup.
 */
export function initScheduler(): void {
  logger.info('Initializing cron scheduler (timezone: Asia/Kolkata)');

  // Daily at 6:00 AM IST — check for orders to send review requests
  cron.schedule('0 6 * * *', async () => {
    logger.info('Cron: daily review requests');
    try {
      await runDailyReviewRequests();
    } catch (err) {
      logger.error({ err }, 'Cron: daily review requests failed');
    }
  }, IST);

  // Daily at 2:00 AM IST — full reconciliation sync with WooCommerce
  cron.schedule('0 2 * * *', async () => {
    logger.info('Cron: daily sheets sync');
    try {
      await runDailySheetsSync();
    } catch (err) {
      logger.error({ err }, 'Cron: daily sheets sync failed');
    }
  }, IST);

  // Weekly Sunday 10:00 PM IST — competitor monitoring crawl
  cron.schedule('0 22 * * 0', async () => {
    logger.info('Cron: weekly competitor crawl');
    try {
      await runWeeklyCompetitorCrawl();
    } catch (err) {
      logger.error({ err }, 'Cron: weekly competitor crawl failed');
    }
  }, IST);

  // Weekly Monday 9:00 AM IST — batch SEO/AEO content for new products
  cron.schedule('0 9 * * 1', async () => {
    logger.info('Cron: weekly content generation');
    try {
      await runWeeklyContentGeneration();
    } catch (err) {
      logger.error({ err }, 'Cron: weekly content generation failed');
    }
  }, IST);

  logger.info('Cron scheduler initialized with 4 jobs');
}
