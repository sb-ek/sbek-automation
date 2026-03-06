import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import { competitorSnapshots } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { crawler } from '../services/crawler.service.js';
import { openai } from '../services/openai.service.js';
import { sheets } from '../services/googlesheets.service.js';
import { notification } from '../queues/registry.js';
import { settings } from '../services/settings.service.js';
import { email as emailService } from '../services/email.service.js';
import { formatDate } from '../utils/date.js';
import type { CompetitorCrawlPayload } from '../queues/types.js';

interface PriceChange {
  productName: string;
  oldPrice: string;
  newPrice: string;
  changePercent: string;
  isPriceIncrease: boolean;
}

/**
 * Competitor Monitoring Workflow
 *
 * Flow:
 * 1. Fetch previous snapshot from DB for delta comparison
 * 2. Crawl the competitor website (built-in scraper)
 * 3. Store new snapshot in DB
 * 4. Analyse with AI (pricing, SEO, messaging, trends)
 * 5. Update Competitors tab in Sheets with summary
 * 6. Log full analysis to System Logs tab
 * 7. Send email report to admin (ADMIN_EMAIL setting)
 * 8. If significant changes detected, send WhatsApp alert
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

  // 2. Crawl the competitor site
  const crawlData = await crawler.analyzeSite(url, previousCrawlData);

  const productsFound = crawlData.products?.length ?? 0;
  logger.info({ competitorName, productsFound }, 'Competitor site crawled');

  // Compute summary stats (null-safe)
  const products = crawlData.products ?? [];
  const prices = products
    .map((p) => p.price)
    .filter((p) => p > 0);
  const priceRange = prices.length > 0
    ? `${Math.min(...prices).toLocaleString('en-IN')} - ${Math.max(...prices).toLocaleString('en-IN')} INR`
    : 'N/A';

  // SEO score: simple heuristic (0-10)
  let seoScore = 0;
  if (crawlData.meta?.description) seoScore += 2;
  if (crawlData.techSeo?.hasSchema) seoScore += 2;
  if (crawlData.techSeo?.hasOpenGraph) seoScore += 1;
  if (crawlData.techSeo?.hasSitemap) seoScore += 2;
  if (crawlData.techSeo?.h1Tags?.length > 0) seoScore += 1;
  if (crawlData.meta?.canonical) seoScore += 1;
  if (crawlData.techSeo?.robotsTxt) seoScore += 1;

  // 3. Store new snapshot in DB
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

  // 3b. Compare prices with previous crawl and alert on significant changes
  if (previousCrawlData) {
    try {
      const previousProducts = (previousCrawlData as Record<string, unknown>).products as
        | Array<{ name?: string; price?: number }>
        | undefined;
      const currentProducts = crawlData.products ?? [];

      if (previousProducts && previousProducts.length > 0 && currentProducts.length > 0) {
        // Build a lookup from the previous crawl by product name
        const prevPriceMap = new Map<string, number>();
        for (const p of previousProducts) {
          if (p.name && typeof p.price === 'number' && p.price > 0) {
            prevPriceMap.set(p.name.toLowerCase(), p.price);
          }
        }

        const significantChanges: PriceChange[] = [];

        for (const product of currentProducts) {
          if (!product.name || typeof product.price !== 'number' || product.price <= 0) continue;
          const prevPrice = prevPriceMap.get(product.name.toLowerCase());
          if (prevPrice === undefined || prevPrice <= 0) continue;

          const changePct = ((product.price - prevPrice) / prevPrice) * 100;
          if (Math.abs(changePct) > 10) {
            significantChanges.push({
              productName: product.name,
              oldPrice: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(prevPrice),
              newPrice: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(product.price),
              changePercent: (changePct > 0 ? '+' : '') + changePct.toFixed(1),
              isPriceIncrease: changePct > 0,
            });
          }
        }

        if (significantChanges.length > 0) {
          logger.info(
            { competitorName, changedProducts: significantChanges.length },
            'Significant price changes detected — sending price alert',
          );
          await sendPriceAlert(competitorName, url, significantChanges);
        }
      }
    } catch (err) {
      logger.warn({ err, competitorName }, 'Failed to compare prices with previous crawl');
    }
  }

  // 4. Analyse with AI
  const analysis = await openai.analyzeCompetitorEnhanced(
    competitorName,
    crawlData as unknown as Record<string, unknown>,
    previousCrawlData,
  );

  logger.info({ competitorName }, 'Enhanced competitor analysis completed');

  // 5. Update Competitors tab with summary
  const hasSignificantChanges = detectSignificantChanges(analysis);
  try {
    await sheets.updateCompetitor(competitorName, {
      'Last Crawled': formatDate(new Date()),
      'Products Found': String(productsFound),
      'Price Range': priceRange,
      'SEO Score': `${seoScore}/10`,
      'AI Analysis': analysis.slice(0, 500),
      'Changes Detected': hasSignificantChanges ? 'Yes' : 'No',
    });
  } catch (err) {
    logger.warn({ err, competitorName }, 'Failed to update Competitors tab');
  }

  // 6. Log full analysis to System Logs
  try {
    await sheets.logEvent(
      'info',
      'competitor-monitoring',
      `Competitor analysis: ${competitorName}`,
      analysis,
    );
  } catch (err) {
    logger.warn({ err, competitorName }, 'Failed to log competitor analysis to Sheets');
  }

  // 7. Send email report to admin
  const adminEmail = await settings.get('ADMIN_EMAIL');
  if (adminEmail) {
    try {
      await notification.add(`competitor-report-${competitorName}-${Date.now()}`, {
        channel: 'email',
        recipientEmail: adminEmail,
        recipientName: 'SBEK Admin',
        templateName: 'competitor_alert',
        templateData: {
          competitor_name: competitorName,
          competitor_url: url,
          crawl_date: formatDate(new Date()),
          products_found: String(productsFound),
          price_range: priceRange,
          seo_score: `${seoScore}/10`,
          pages_scraped: String(crawlData.pageCount),
          analysis: analysis,
          changes_detected: hasSignificantChanges ? 'Significant competitive changes detected — review recommended.' : '',
        },
      }, { jobId: `competitor-report-${competitorName}-${Date.now()}` });
      logger.info({ competitorName, adminEmail }, 'Competitor report email sent to admin');
    } catch (err) {
      logger.error({ err, competitorName }, 'Failed to send competitor report email');
    }
  } else {
    logger.warn('No ADMIN_EMAIL configured — skipping competitor report email. Set it in Dashboard > Settings.');
  }

  // 8. WhatsApp alert if significant changes
  if (hasSignificantChanges) {
    logger.info({ competitorName }, 'Significant competitor changes detected — sending WhatsApp alert');

    const adminPhone = env.BRAND_SUPPORT_PHONE;
    if (adminPhone) {
      await notification.add(`competitor-whatsapp-${competitorName}`, {
        channel: 'whatsapp',
        recipientPhone: adminPhone,
        recipientName: 'SBEK Admin',
        templateName: 'competitor_alert',
        templateData: {
          competitor_name: competitorName,
          competitor_url: url,
          crawl_date: formatDate(new Date()),
          products_found: String(productsFound),
          price_range: priceRange,
          seo_score: `${seoScore}/10`,
          pages_scraped: String(crawlData.pageCount),
          analysis: analysis.slice(0, 500),
          changes_detected: 'Significant competitive changes detected.',
        },
      }, { jobId: `competitor-whatsapp-${competitorName}` });
    }
  }

  logger.info({ competitorName, url, productsFound, seoScore }, 'Competitor monitoring workflow completed');
}

/**
 * Send a price alert email to the brand owner when significant price
 * changes (>10%) are detected for a competitor's products.
 */
async function sendPriceAlert(
  competitorName: string,
  competitorUrl: string,
  priceChanges: PriceChange[],
): Promise<void> {
  const brandOwnerEmail = env.BRAND_OWNER_EMAIL;
  if (!brandOwnerEmail) {
    logger.warn('No BRAND_OWNER_EMAIL configured — skipping price alert email. Set it in your environment.');
    return;
  }

  const increases = priceChanges.filter((c) => c.isPriceIncrease).length;
  const decreases = priceChanges.length - increases;
  const summaryParts: string[] = [];
  if (decreases > 0) summaryParts.push(`${decreases} product(s) dropped in price`);
  if (increases > 0) summaryParts.push(`${increases} product(s) increased in price`);
  const summary = `${competitorName} has ${summaryParts.join(' and ')}. Review these changes to adjust your competitive strategy.`;

  try {
    await emailService.sendEmail(
      brandOwnerEmail,
      `Price Alert: ${competitorName} — ${priceChanges.length} significant price change(s)`,
      'price_alert',
      {
        competitor_name: competitorName,
        competitor_url: competitorUrl,
        alert_date: formatDate(new Date()),
        change_count: String(priceChanges.length),
        price_changes: priceChanges as unknown as string,
        summary,
      },
    );
    logger.info(
      { competitorName, brandOwnerEmail, changedProducts: priceChanges.length },
      'Price alert email sent to brand owner',
    );
  } catch (err) {
    logger.error({ err, competitorName }, 'Failed to send price alert email');
  }
}

/**
 * Heuristic to detect whether the AI analysis mentions significant
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
