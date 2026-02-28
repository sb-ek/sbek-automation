import { logger } from '../../config/logger.js';
import { competitorCrawl } from '../../queues/registry.js';
import { sheets } from '../../services/googlesheets.service.js';

/**
 * Weekly cron: enqueue competitor crawl jobs.
 * Competitor URLs are managed via the Google Sheets "Competitors" tab.
 * Falls back to empty list if no competitors are configured.
 */
export async function runWeeklyCompetitorCrawl(): Promise<void> {
  const competitors = await sheets.getCompetitors();

  if (competitors.length === 0) {
    logger.warn('No active competitors configured in the Competitors sheet tab — skipping crawl');
    return;
  }

  let enqueued = 0;

  for (const competitor of competitors) {
    await competitorCrawl.add(`crawl-${competitor.name}`, {
      competitorName: competitor.name,
      url: competitor.url,
    });
    enqueued++;
  }

  logger.info({ enqueued }, 'Weekly competitor crawl jobs enqueued');
}
