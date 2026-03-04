import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import { competitorSnapshots } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
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
 * 1. Fetch previous snapshot from DB for delta comparison
 * 2. Crawl the competitor website via the crawler microservice
 * 3. Store new snapshot in DB for future comparison
 * 4. Analyse with OpenAI (including messaging/brand voice + technical SEO)
 * 5. Log results to Sheets
 * 6. If significant changes detected, send WhatsApp alert
 */
export async function processCompetitorCrawl(
  payload: CompetitorCrawlPayload,
): Promise<void> {
  const { competitorName, url } = payload;

  logger.info({ competitorName, url }, 'Starting competitor monitoring workflow');

  // 1. Fetch previous snapshot for historical comparison
  let previousCrawlData: Record<string, unknown> | undefined;
  try {
    const prevSnapshots = await db
      .select()
      .from(competitorSnapshots)
      .where(eq(competitorSnapshots.competitorName, competitorName))
      .orderBy(desc(competitorSnapshots.crawledAt))
      .limit(1);

    if (prevSnapshots.length > 0) {
      previousCrawlData = prevSnapshots[0].data as Record<string, unknown>;
      logger.info(
        { competitorName, previousCrawlDate: prevSnapshots[0].crawledAt },
        'Previous snapshot found for delta comparison',
      );
    }
  } catch (err) {
    logger.warn({ err, competitorName }, 'Failed to fetch previous snapshot — proceeding without delta');
  }

  // 2. Crawl the competitor site (pass previous data for delta analysis)
  const crawlData = await crawler.analyzeSite(url, previousCrawlData);

  logger.info(
    { competitorName, productsFound: crawlData.products?.length ?? 0 },
    'Competitor site crawled',
  );

  // 3. Store new snapshot in DB for future comparisons
  try {
    await db.insert(competitorSnapshots).values({
      competitorName,
      url,
      data: crawlData as unknown as Record<string, unknown>,
    });
    logger.info({ competitorName }, 'Competitor snapshot stored in database');
  } catch (err) {
    logger.warn({ err, competitorName }, 'Failed to store competitor snapshot');
  }

  // 4. Analyse with OpenAI — enhanced with messaging analysis + technical SEO
  const analysis = await openai.analyzeCompetitorEnhanced(
    competitorName,
    crawlData as unknown as Record<string, unknown>,
    previousCrawlData,
  );

  logger.info({ competitorName }, 'Enhanced competitor analysis completed');

  // 5. Log results to Sheets
  await sheets.logEvent(
    'info',
    'competitor-monitoring',
    `Competitor analysis: ${competitorName}`,
    analysis,
  );

  // 6. Check for significant changes and send WhatsApp alert if needed
  const hasSignificantChanges = detectSignificantChanges(analysis);

  if (hasSignificantChanges) {
    logger.info({ competitorName }, 'Significant competitor changes detected — sending alert');

    const adminPhone = env.BRAND_SUPPORT_PHONE;
    if (!adminPhone) {
      logger.warn({ competitorName }, 'No BRAND_SUPPORT_PHONE configured — skipping competitor WhatsApp alert');
      return;
    }

    await notification.add(`competitor-alert-${competitorName}`, {
      channel: 'whatsapp',
      recipientPhone: adminPhone,
      recipientName: 'SBEK Admin',
      templateName: 'qc_failed_alert',
      templateData: {
        order_id: competitorName,
        failed_items: `Significant changes detected on ${competitorName}. Check System Logs for full analysis.`,
      },
    }, { jobId: `competitor-alert-${competitorName}` });
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
    'rebranding',
    'new campaign',
    'market shift',
  ];

  const lower = analysis.toLowerCase();
  return significantKeywords.some((keyword) => lower.includes(keyword));
}
