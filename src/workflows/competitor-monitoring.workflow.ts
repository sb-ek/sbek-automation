import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { crawler } from '../services/crawler.service.js';
import { openai } from '../services/openai.service.js';
import { sheets } from '../services/googlesheets.service.js';
import { notification } from '../queues/registry.js';
import type { CompetitorCrawlPayload } from '../queues/types.js';

/**
 * Competitor Monitoring Workflow
 *
 * Triggered by: competitor-crawl queue worker
 *
 * Flow:
 * 1. Crawl the competitor website via the crawler microservice
 * 2. Analyse the crawl data with OpenAI for competitive insights
 * 3. Log the analysis to the "System Logs" sheet
 * 4. If significant changes are detected, send an internal WhatsApp alert
 */
export async function processCompetitorCrawl(
  payload: CompetitorCrawlPayload,
): Promise<void> {
  const { competitorName, url } = payload;

  logger.info({ competitorName, url }, 'Starting competitor monitoring workflow');

  // 1. Crawl the competitor site
  const crawlData = await crawler.analyzeSite(url);

  logger.info(
    { competitorName, productsFound: crawlData.products?.length ?? 0 },
    'Competitor site crawled',
  );

  // 2. Analyse with OpenAI
  const analysis = await openai.analyzeCompetitor(competitorName, crawlData as unknown as Record<string, unknown>);

  logger.info({ competitorName }, 'Competitor analysis completed');

  // 3. Log results to Sheets
  await sheets.logEvent(
    'info',
    'competitor-monitoring',
    `Competitor analysis: ${competitorName}`,
    analysis,
  );

  // 4. Check for significant changes and send WhatsApp alert if needed
  const hasSignificantChanges = detectSignificantChanges(analysis);

  if (hasSignificantChanges) {
    logger.info({ competitorName }, 'Significant competitor changes detected — sending alert');

    const adminPhone = env.BRAND_SUPPORT_PHONE;
    if (!adminPhone) {
      logger.warn({ competitorName }, 'No BRAND_SUPPORT_PHONE configured — skipping competitor WhatsApp alert');
      return;
    }

    await notification.add(`competitor-alert-${competitorName}-${Date.now()}`, {
      channel: 'whatsapp',
      recipientPhone: adminPhone,
      recipientName: 'SBEK Admin',
      templateName: 'qc_failed_alert',
      templateData: {
        order_id: competitorName,
        failed_items: `Significant changes detected on ${competitorName}. Check System Logs for full analysis.`,
      },
    });
  }

  logger.info({ competitorName, url }, 'Competitor monitoring workflow completed');
}

/**
 * Heuristic to detect whether the OpenAI analysis mentions significant
 * competitive changes worth alerting the team about.
 */
function detectSignificantChanges(analysis: string): boolean {
  const significantKeywords = [
    'new product',
    'new collection',
    'price drop',
    'price reduction',
    'major discount',
    'clearance',
    'new launch',
    'significant change',
    'urgent',
    'aggressive pricing',
  ];

  const lower = analysis.toLowerCase();
  return significantKeywords.some((keyword) => lower.includes(keyword));
}
