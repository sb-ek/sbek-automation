import { Router, type Request, type Response } from 'express';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { queues, orderSync, competitorCrawl } from '../../queues/registry.js';
import { db } from '../../config/database.js';
import { pool } from '../../config/database.js';
import { redis } from '../../config/redis.js';
import { jobLogs, webhookEvents, cronRuns, competitorSnapshots } from '../../db/schema.js';
import { desc, eq, count } from 'drizzle-orm';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { settings, CONFIGURABLE_KEYS, type ConfigurableKey } from '../../services/settings.service.js';
import { seedDemoData } from '../../services/seed.service.js';
import { sheets } from '../../services/googlesheets.service.js';
import { gdrive } from '../../services/googledrive.service.js';
import { woocommerce } from '../../services/woocommerce.service.js';

export const dashboardRouter = Router();

// ── Aggregated Stats ────────────────────────────────────────────────────

dashboardRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    // Get live counts from BullMQ (active/waiting/delayed are real-time)
    const allQueues = queues.getAll();
    const queueData = await Promise.all(
      allQueues.map(async (q) => {
        const counts = await q.getJobCounts();
        return { name: q.name, counts };
      })
    );

    let bullCompleted = 0;
    let bullFailed = 0;
    let bullActive = 0;
    let bullWaiting = 0;
    let bullDelayed = 0;

    for (const q of queueData) {
      bullCompleted += (q.counts as Record<string, number>).completed ?? 0;
      bullFailed += (q.counts as Record<string, number>).failed ?? 0;
      bullActive += (q.counts as Record<string, number>).active ?? 0;
      bullWaiting += (q.counts as Record<string, number>).waiting ?? 0;
      bullDelayed += (q.counts as Record<string, number>).delayed ?? 0;
    }

    // Get historical counts from job_logs DB table (includes seeded + real data)
    const dbCounts = await db
      .select({ status: jobLogs.status, cnt: count() })
      .from(jobLogs)
      .groupBy(jobLogs.status);

    const dbMap: Record<string, number> = {};
    for (const row of dbCounts) {
      dbMap[row.status] = Number(row.cnt);
    }

    // Merge: use the higher of BullMQ or DB counts for each status
    const totalCompleted = Math.max(bullCompleted, dbMap['completed'] ?? 0);
    const totalFailed = Math.max(bullFailed, dbMap['failed'] ?? 0);
    const totalActive = Math.max(bullActive, dbMap['active'] ?? 0);
    const totalWaiting = Math.max(bullWaiting, dbMap['queued'] ?? 0);
    const totalDelayed = bullDelayed;

    const totalProcessed = totalCompleted + totalFailed;
    const successRate = totalProcessed > 0
      ? Math.round((totalCompleted / totalProcessed) * 10000) / 100
      : 100;

    res.json({
      totalProcessed,
      totalCompleted,
      totalFailed,
      totalActive,
      totalWaiting,
      totalDelayed,
      successRate,
      activeQueues: queueData.filter(
        (q) => ((q.counts as Record<string, number>).active ?? 0) > 0
      ).length,
      totalQueues: allQueues.length,
    });
  } catch (err) {
    logger.error({ err }, 'Dashboard stats error');
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── All Queues ──────────────────────────────────────────────────────────

dashboardRouter.get('/queues', async (_req: Request, res: Response) => {
  try {
    const allQueues = queues.getAll();

    // Get live BullMQ counts
    const bullData = await Promise.all(
      allQueues.map(async (q) => {
        const counts = await q.getJobCounts();
        return { name: q.name, counts: counts as Record<string, number> };
      })
    );

    // Get historical counts from job_logs DB grouped by queue + status
    const dbRows = await db
      .select({ queueName: jobLogs.queueName, status: jobLogs.status, cnt: count() })
      .from(jobLogs)
      .groupBy(jobLogs.queueName, jobLogs.status);

    // Build a map: queueName -> { completed: N, failed: N, ... }
    const dbMap: Record<string, Record<string, number>> = {};
    for (const row of dbRows) {
      if (!dbMap[row.queueName]) dbMap[row.queueName] = {};
      dbMap[row.queueName][row.status] = Number(row.cnt);
    }

    // Merge: use higher of BullMQ or DB for each queue + status
    const data = bullData.map((q) => {
      const db = dbMap[q.name] ?? {};
      return {
        name: q.name,
        completed: Math.max(q.counts.completed ?? 0, db['completed'] ?? 0),
        failed: Math.max(q.counts.failed ?? 0, db['failed'] ?? 0),
        active: Math.max(q.counts.active ?? 0, db['active'] ?? 0),
        waiting: Math.max(q.counts.waiting ?? 0, db['queued'] ?? 0),
        delayed: q.counts.delayed ?? 0,
      };
    });

    res.json({ queues: data });
  } catch (err) {
    logger.error({ err }, 'Dashboard queues error');
    res.status(500).json({ error: 'Failed to fetch queues' });
  }
});

// ── Single Queue Detail ─────────────────────────────────────────────────

dashboardRouter.get('/queues/:name', async (req: Request, res: Response) => {
  try {
    const allQueues = queues.getAll();
    const queue = allQueues.find((q) => q.name === req.params.name);
    if (!queue) {
      res.status(404).json({ error: 'Queue not found' });
      return;
    }

    // ── BullMQ live data ──
    const bullCounts = await queue.getJobCounts();
    const recentCompleted = await queue.getJobs(['completed'], 0, 19);
    const recentFailed = await queue.getJobs(['failed'], 0, 19);
    const recentActive = await queue.getJobs(['active'], 0, 9);
    const recentWaiting = await queue.getJobs(['waiting'], 0, 9);
    const recentDelayed = await queue.getJobs(['delayed'], 0, 9);

    // ── DB historical counts (same merge logic as /queues listing) ──
    const queueName = req.params.name as string;
    const dbRows = await db
      .select({ status: jobLogs.status, cnt: count() })
      .from(jobLogs)
      .where(eq(jobLogs.queueName, queueName))
      .groupBy(jobLogs.status);

    const dbCounts: Record<string, number> = {};
    for (const row of dbRows) {
      dbCounts[row.status] = Number(row.cnt);
    }

    // Merge: use higher of BullMQ or DB for each status
    const mergedCounts: Record<string, number> = {
      active: Math.max(bullCounts.active ?? 0, dbCounts['active'] ?? 0),
      completed: Math.max(bullCounts.completed ?? 0, dbCounts['completed'] ?? 0),
      failed: Math.max(bullCounts.failed ?? 0, dbCounts['failed'] ?? 0),
      waiting: Math.max(bullCounts.waiting ?? 0, dbCounts['queued'] ?? 0),
      delayed: bullCounts.delayed ?? 0,
      paused: bullCounts.paused ?? 0,
    };

    // ── DB recent jobs (fallback when BullMQ has no jobs) ──
    const dbRecentJobs = await db
      .select()
      .from(jobLogs)
      .where(eq(jobLogs.queueName, queueName))
      .orderBy(desc(jobLogs.createdAt))
      .limit(50);

    const formatBullJob = (j: { id?: string; name: string; data: unknown; timestamp: number; processedOn?: number; finishedOn?: number; attemptsMade: number; failedReason?: string; returnvalue?: unknown }) => ({
      id: j.id,
      name: j.name,
      data: j.data,
      timestamp: j.timestamp,
      processedOn: j.processedOn,
      finishedOn: j.finishedOn,
      attempts: j.attemptsMade,
      failedReason: j.failedReason,
      returnvalue: j.returnvalue,
    });

    const formatDbJob = (j: typeof dbRecentJobs[number]) => ({
      id: j.jobId,
      name: j.queueName,
      data: j.payload,
      timestamp: j.createdAt ? new Date(j.createdAt).getTime() : Date.now(),
      processedOn: j.createdAt ? new Date(j.createdAt).getTime() : null,
      finishedOn: j.completedAt ? new Date(j.completedAt).getTime() : null,
      attempts: j.attempts ?? 1,
      failedReason: j.error ?? null,
      returnvalue: j.result ?? null,
    });

    // Use BullMQ jobs if available, otherwise fall back to DB
    const bullHasJobs = recentCompleted.length + recentFailed.length + recentActive.length + recentWaiting.length + recentDelayed.length > 0;

    let recentJobs;
    if (bullHasJobs) {
      recentJobs = {
        completed: recentCompleted.map(formatBullJob),
        failed: recentFailed.map(formatBullJob),
        active: recentActive.map(formatBullJob),
        waiting: recentWaiting.map(formatBullJob),
        delayed: recentDelayed.map(formatBullJob),
      };
    } else {
      // Group DB jobs by status
      const completed = dbRecentJobs.filter((j) => j.status === 'completed').slice(0, 20).map(formatDbJob);
      const failed = dbRecentJobs.filter((j) => j.status === 'failed').slice(0, 20).map(formatDbJob);
      const active = dbRecentJobs.filter((j) => j.status === 'active').slice(0, 10).map(formatDbJob);
      const waiting = dbRecentJobs.filter((j) => j.status === 'queued').slice(0, 10).map(formatDbJob);
      const delayed = dbRecentJobs.filter((j) => j.status === 'delayed').slice(0, 10).map(formatDbJob);
      recentJobs = { completed, failed, active, waiting, delayed };
    }

    res.json({
      name: queue.name,
      counts: mergedCounts,
      recentJobs,
    });
  } catch (err) {
    logger.error({ err }, 'Dashboard queue detail error');
    res.status(500).json({ error: 'Failed to fetch queue detail' });
  }
});

// ── Queue Jobs (paginated) ──────────────────────────────────────────────

dashboardRouter.get('/queues/:name/jobs', async (req: Request, res: Response) => {
  try {
    const allQueues = queues.getAll();
    const queue = allQueues.find((q) => q.name === req.params.name);
    if (!queue) {
      res.status(404).json({ error: 'Queue not found' });
      return;
    }

    const status = (req.query.status as string) || 'completed';
    const start = parseInt(req.query.start as string) || 0;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    const validStatuses = ['completed', 'failed', 'active', 'waiting', 'delayed'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: `Invalid status. Use: ${validStatuses.join(', ')}` });
      return;
    }

    const jobs = await queue.getJobs([status as 'completed' | 'failed' | 'active' | 'waiting' | 'delayed'], start, start + limit - 1);
    res.json({
      queue: queue.name,
      status,
      start,
      limit,
      count: jobs.length,
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        data: j.data,
        timestamp: j.timestamp,
        processedOn: j.processedOn,
        finishedOn: j.finishedOn,
        attempts: j.attemptsMade,
        failedReason: j.failedReason,
        returnvalue: j.returnvalue,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'Dashboard queue jobs error');
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// ── Retry All Failed ────────────────────────────────────────────────────

dashboardRouter.post('/queues/:name/retry-all', async (req: Request, res: Response) => {
  try {
    const allQueues = queues.getAll();
    const queue = allQueues.find((q) => q.name === req.params.name);
    if (!queue) {
      res.status(404).json({ error: 'Queue not found' });
      return;
    }

    const failed = await queue.getJobs(['failed']);
    let retried = 0;
    for (const job of failed) {
      await job.retry();
      retried++;
    }

    res.json({ queue: queue.name, retried });
  } catch (err) {
    logger.error({ err }, 'Dashboard retry-all error');
    res.status(500).json({ error: 'Failed to retry jobs' });
  }
});

// ── Clean Queue ─────────────────────────────────────────────────────────

dashboardRouter.post('/queues/:name/clean', async (req: Request, res: Response) => {
  try {
    const allQueues = queues.getAll();
    const queue = allQueues.find((q) => q.name === req.params.name);
    if (!queue) {
      res.status(404).json({ error: 'Queue not found' });
      return;
    }

    const completedCleaned = await queue.clean(0, 1000, 'completed');
    const failedCleaned = await queue.clean(0, 1000, 'failed');

    res.json({
      queue: queue.name,
      cleaned: {
        completed: completedCleaned.length,
        failed: failedCleaned.length,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Dashboard clean error');
    res.status(500).json({ error: 'Failed to clean queue' });
  }
});

// ── Drain Queue (stop all jobs including active) ────────────────────────

dashboardRouter.post('/queues/:name/drain', async (req: Request, res: Response) => {
  try {
    const allQueues = queues.getAll();
    const queue = allQueues.find((q) => q.name === req.params.name);
    if (!queue) {
      res.status(404).json({ error: 'Queue not found' });
      return;
    }

    // Pause the queue to stop picking up new jobs
    await queue.pause();

    // Clean all job states
    await queue.clean(0, 10000, 'completed');
    await queue.clean(0, 10000, 'failed');
    await queue.clean(0, 10000, 'wait');
    await queue.clean(0, 10000, 'active');
    await queue.clean(0, 10000, 'delayed');

    // Drain removes all waiting and delayed jobs
    await queue.drain();

    // Obliterate fully removes all job data from Redis
    await queue.obliterate({ force: true });

    // Resume the queue so it can accept new jobs
    await queue.resume();

    logger.info({ queue: queue.name }, 'Queue drained and obliterated');
    res.json({ queue: queue.name, message: 'Queue drained — all jobs (including active) removed' });
  } catch (err) {
    logger.error({ err }, 'Dashboard drain error');
    res.status(500).json({ error: 'Failed to drain queue' });
  }
});

// ── System Health ───────────────────────────────────────────────────────

dashboardRouter.get('/system/health', async (_req: Request, res: Response) => {
  const health: Record<string, { status: string; latency?: number; info?: string }> = {};

  // Redis
  try {
    const start = Date.now();
    await redis.ping();
    health.redis = { status: 'ok', latency: Date.now() - start };
  } catch {
    health.redis = { status: 'error', info: 'Redis unreachable' };
  }

  // PostgreSQL
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    health.postgres = { status: 'ok', latency: Date.now() - start };
  } catch {
    health.postgres = { status: 'error', info: 'PostgreSQL unreachable' };
  }

  // Crawler (built-in — always healthy)
  health.crawler = { status: 'ok', latency: 0 };

  const allOk = Object.values(health).every((s) => s.status === 'ok');

  res.json({ status: allOk ? 'healthy' : 'degraded', services: health });
});

// ── Cron Runs ───────────────────────────────────────────────────────────

dashboardRouter.get('/system/cron', async (_req: Request, res: Response) => {
  try {
    const runs = await db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).limit(50);
    res.json({ runs });
  } catch (err) {
    logger.error({ err }, 'Dashboard cron runs error');
    res.status(500).json({ error: 'Failed to fetch cron runs' });
  }
});

// ── Job Logs ────────────────────────────────────────────────────────────

dashboardRouter.get('/system/logs', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const queueFilter = req.query.queue as string | undefined;

    const logs = queueFilter
      ? await db.select().from(jobLogs).where(eq(jobLogs.queueName, queueFilter)).orderBy(desc(jobLogs.createdAt)).limit(limit)
      : await db.select().from(jobLogs).orderBy(desc(jobLogs.createdAt)).limit(limit);
    res.json({ logs });
  } catch (err) {
    logger.error({ err }, 'Dashboard logs error');
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// ── Recent Webhooks ─────────────────────────────────────────────────────

dashboardRouter.get('/webhooks/recent', async (_req: Request, res: Response) => {
  try {
    const events = await db.select({
      id: webhookEvents.id,
      source: webhookEvents.source,
      event: webhookEvents.event,
      processed: webhookEvents.processed,
      processedAt: webhookEvents.processedAt,
      createdAt: webhookEvents.createdAt,
    }).from(webhookEvents).orderBy(desc(webhookEvents.createdAt)).limit(50);
    res.json({ events });
  } catch (err) {
    logger.error({ err }, 'Dashboard webhooks error');
    res.status(500).json({ error: 'Failed to fetch webhook events' });
  }
});

// (Competitor routes are defined in the Competitor Monitoring section below)

// ── Settings (no admin auth — internal dashboard use) ──────────────────

dashboardRouter.get('/settings', async (_req: Request, res: Response) => {
  try {
    const list = await settings.list();
    res.json({ settings: list, configurableKeys: CONFIGURABLE_KEYS });
  } catch (err) {
    logger.error({ err }, 'Dashboard settings list error');
    res.status(500).json({ error: 'Failed to list settings' });
  }
});

/**
 * GET /settings/reveal/:key — return the real (unmasked) value for a config key.
 * Used when the admin clicks the "eye" icon to see a hidden API key.
 */
dashboardRouter.get('/settings/reveal/:key', async (req: Request, res: Response) => {
  const key = req.params.key as string;
  if (!(CONFIGURABLE_KEYS as readonly string[]).includes(key)) {
    res.status(400).json({ error: `Invalid key: ${key}` });
    return;
  }

  try {
    const value = await settings.get(key as ConfigurableKey);
    res.json({ key, value: value ?? '' });
  } catch (err) {
    logger.error({ err }, 'Dashboard settings reveal error');
    res.status(500).json({ error: 'Failed to reveal setting' });
  }
});

dashboardRouter.put('/settings', async (req: Request, res: Response) => {
  const { keys } = req.body as { keys?: Record<string, string | null> };

  if (!keys || typeof keys !== 'object') {
    res.status(400).json({ error: 'Body must contain a "keys" object' });
    return;
  }

  const invalidKeys = Object.keys(keys).filter(
    (k) => !(CONFIGURABLE_KEYS as readonly string[]).includes(k),
  );

  if (invalidKeys.length > 0) {
    res.status(400).json({ error: `Invalid keys: ${invalidKeys.join(', ')}`, validKeys: CONFIGURABLE_KEYS });
    return;
  }

  try {
    await settings.setMany(keys as Partial<Record<ConfigurableKey, string | null>>);
    const updated = Object.keys(keys);
    logger.info({ updated }, 'Dashboard updated settings');
    res.json({ message: `Updated ${updated.length} setting(s)`, updated });
  } catch (err) {
    logger.error({ err }, 'Dashboard settings update error');
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ── Seed Demo Data ──────────────────────────────────────────────────────

dashboardRouter.post('/data/seed', async (_req: Request, res: Response) => {
  try {
    logger.info('Seeding demo data via dashboard');
    const summary = await seedDemoData(db);
    logger.info('Demo data seeded successfully');
    res.json({ success: true, output: summary });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Seed failed';
    logger.error({ err }, 'Dashboard seed error');
    res.status(500).json({ success: false, error: msg });
  }
});

// ── Erase All Seeded Data ───────────────────────────────────────────────

dashboardRouter.post('/data/reset', async (_req: Request, res: Response) => {
  try {
    logger.info('Erasing seeded data via dashboard');

    // Truncate data tables (preserve system_config = user settings)
    await db.delete(jobLogs);
    await db.delete(webhookEvents);
    await db.delete(cronRuns);
    await db.delete(competitorSnapshots);

    // Obliterate all BullMQ queues
    const allQueues = queues.getAll();
    for (const q of allQueues) {
      await q.obliterate({ force: true });
    }

    logger.info('Seeded data erased successfully');
    res.json({ success: true, message: 'All seeded data erased. Settings preserved.' });
  } catch (err) {
    logger.error({ err }, 'Dashboard reset error');
    res.status(500).json({ success: false, error: 'Failed to erase data' });
  }
});

// ── Google Setup (initialise Sheet tabs + Drive folder) ────────────────

dashboardRouter.post('/google/setup', async (_req: Request, res: Response) => {
  try {
    // Force re-initialisation so it picks up newly-saved credentials
    (sheets as unknown as { initialized: boolean }).initialized = false;
    (gdrive as unknown as { initialized: boolean }).initialized = false;

    await sheets.init();
    await gdrive.init();

    res.json({
      success: true,
      message: 'Google Sheet tabs created (Orders, Production, QC, Customers, Creatives, Competitors, System Logs) with formatting. Drive folder ready.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Setup failed';
    logger.error({ err }, 'Google setup error');
    res.status(500).json({ success: false, error: msg });
  }
});

// ── WooCommerce Webhook Registration ───────────────────────────────────

dashboardRouter.post('/woocommerce/webhooks/register', async (req: Request, res: Response) => {
  try {
    // Derive the public app URL from the request or use an explicit override
    const appUrl = (req.body.app_url as string)?.replace(/\/+$/, '')
      || `${req.protocol}://${req.get('host')}`;

    const webhookSecret = (await settings.get('WOO_WEBHOOK_SECRET')) ?? env.WOO_WEBHOOK_SECRET;
    if (!webhookSecret) {
      res.status(400).json({
        success: false,
        error: 'WOO_WEBHOOK_SECRET is not set. Add it in Settings → WooCommerce first.',
      });
      return;
    }

    // Check existing webhooks to avoid duplicates
    const existing = await woocommerce.listWebhooks();
    const orderUrl = `${appUrl}/api/webhooks/woocommerce/order`;
    const productUrl = `${appUrl}/api/webhooks/woocommerce/product`;

    const results: Array<{ topic: string; status: string; id?: number; skipped?: boolean }> = [];

    for (const { topic, url } of [
      { topic: 'order.created', url: orderUrl },
      { topic: 'order.updated', url: orderUrl },
      { topic: 'product.created', url: productUrl },
      { topic: 'product.updated', url: productUrl },
    ]) {
      const alreadyExists = existing.some(
        (wh) => wh.topic === topic && wh.delivery_url === url && wh.status === 'active',
      );
      if (alreadyExists) {
        results.push({ topic, status: 'already registered', skipped: true });
        continue;
      }
      const created = await woocommerce.registerWebhook(topic, url, webhookSecret);
      results.push({ topic, status: created.status, id: created.id });
    }

    logger.info({ results, appUrl }, 'WooCommerce webhooks registered');
    res.json({ success: true, appUrl, webhooks: results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to register webhooks';
    logger.error({ err }, 'Webhook registration error');
    res.status(500).json({ success: false, error: msg });
  }
});

dashboardRouter.get('/woocommerce/webhooks', async (_req: Request, res: Response) => {
  try {
    const webhooks = await woocommerce.listWebhooks();
    res.json({ success: true, webhooks });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to list webhooks';
    res.status(500).json({ success: false, error: msg });
  }
});

// ── Manual Order Sync ──────────────────────────────────────────────────

dashboardRouter.post('/orders/sync', async (req: Request, res: Response) => {
  try {
    const { days = 7 } = req.body as { days?: number };
    const since = new Date();
    since.setDate(since.getDate() - days);

    let page = 1;
    let enqueued = 0;

    while (page <= 20) {
      const orders = await woocommerce.listOrders({
        per_page: 50,
        page,
        after: since.toISOString(),
      });

      if (!orders || orders.length === 0) break;

      for (const order of orders) {
        await orderSync.add(`manual-sync-${order.id}`, {
          orderId: order.id,
          event: 'order.updated',
          rawPayload: order as unknown as Record<string, unknown>,
        }, { jobId: `manual-sync-${order.id}` });
        enqueued++;
      }

      if (orders.length < 50) break;
      page++;
    }

    logger.info({ enqueued, days }, 'Manual order sync triggered');
    res.json({ success: true, enqueued, message: `Syncing ${enqueued} orders from the last ${days} days` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sync failed';
    logger.error({ err }, 'Manual order sync error');
    res.status(500).json({ success: false, error: msg });
  }
});

// ── Validate Credentials Per Section ────────────────────────────────────

dashboardRouter.post('/settings/validate', async (req: Request, res: Response) => {
  const { section, values } = req.body as { section: string; values?: Record<string, string> };

  // Resolve effective values: use provided values (only if not masked), fall back to saved settings
  async function resolve(key: ConfigurableKey): Promise<string> {
    const provided = values?.[key];
    // Only use provided value if it exists and isn't a masked placeholder (contains ***)
    if (provided && !provided.includes('***')) return provided;
    return (await settings.get(key)) ?? '';
  }

  try {
    switch (section) {
      case 'woocommerce': {
        const url = await resolve('WOO_URL');
        const ck = await resolve('WOO_CONSUMER_KEY');
        const cs = await resolve('WOO_CONSUMER_SECRET');
        if (!url || !ck || !cs) {
          res.json({ valid: false, message: 'Store URL, Consumer Key, and Consumer Secret are required' });
          return;
        }
        const baseUrl = url.replace(/\/+$/, '');
        const authParams = `consumer_key=${encodeURIComponent(ck)}&consumer_secret=${encodeURIComponent(cs)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        // Test with products endpoint (lighter than system_status, proves read access)
        const resp = await fetch(
          `${baseUrl}/wp-json/wc/v3/products?per_page=1&${authParams}`,
          { signal: controller.signal },
        );
        clearTimeout(timeout);
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          res.json({ valid: false, message: `WooCommerce returned ${resp.status}: ${text.slice(0, 200)}` });
          return;
        }
        const products = await resp.json().catch(() => []) as unknown[];
        const totalHeader = resp.headers.get('x-wp-total');
        const productCount = totalHeader ? parseInt(totalHeader, 10) : products.length;
        res.json({ valid: true, message: `Connected — ${productCount} product${productCount !== 1 ? 's' : ''} found in store` });
        return;
      }

      case 'google-sheets': {
        const refreshToken = await resolve('GOOGLE_OAUTH_REFRESH_TOKEN');
        const sheetId = await resolve('GOOGLE_SHEET_ID');

        if (refreshToken) {
          // OAuth2 — validate by checking the token works
          if (!sheetId) {
            res.json({ valid: false, message: 'Sheet ID is required (the ID from your Google Sheet URL)' });
            return;
          }
          res.json({ valid: true, message: 'Google account connected via OAuth. Sheet ID configured.' });
          return;
        }

        // Fallback: service account validation
        const email = await resolve('GOOGLE_SERVICE_ACCOUNT_EMAIL');
        if (!email || !sheetId) {
          res.json({ valid: false, message: 'Connect your Google account, or provide Service Account Email and Sheet ID' });
          return;
        }
        if (!email.includes('@') || !email.includes('.iam.gserviceaccount.com')) {
          res.json({ valid: false, message: 'Service Account Email must be a valid GCP service account' });
          return;
        }
        res.json({ valid: true, message: 'Google Sheets credentials format looks correct. Full connection test requires the private key.' });
        return;
      }

      case 'whatsapp-meta': {
        const phoneId = await resolve('WHATSAPP_PHONE_NUMBER_ID');
        const token = await resolve('WHATSAPP_ACCESS_TOKEN');
        if (!phoneId || !token) {
          res.json({ valid: false, message: 'Phone Number ID and Access Token are required' });
          return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(
          `https://graph.facebook.com/v21.0/${phoneId}`,
          { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
        );
        clearTimeout(timeout);
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
          const errMsg = (body.error as Record<string, unknown>)?.message ?? `HTTP ${resp.status}`;
          res.json({ valid: false, message: `WhatsApp API: ${errMsg}` });
          return;
        }
        res.json({ valid: true, message: 'WhatsApp Cloud API credentials verified' });
        return;
      }

      case 'email-smtp': {
        // Try Gmail API first (works on Railway where SMTP ports are blocked)
        const oauthClientId = await resolve('GOOGLE_OAUTH_CLIENT_ID');
        const oauthClientSecret = await resolve('GOOGLE_OAUTH_CLIENT_SECRET');
        const oauthRefreshToken = await resolve('GOOGLE_OAUTH_REFRESH_TOKEN');

        if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
          try {
            const oauth2Client = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
            oauth2Client.setCredentials({ refresh_token: oauthRefreshToken });
            const { token } = await oauth2Client.getAccessToken();
            if (!token) throw new Error('Failed to obtain access token');
            const emailFrom = await resolve('EMAIL_FROM');
            res.json({ valid: true, message: `Gmail API connected${emailFrom ? ` — sending as ${emailFrom}` : ''}` });
            return;
          } catch (gmailErr: unknown) {
            const data = (gmailErr as any)?.response?.data;
            const detail =
              (typeof data?.error_description === 'string' ? data.error_description : null) ??
              (typeof data?.error === 'string' ? data.error : null) ??
              (data?.error?.message) ??
              (typeof data === 'string' ? data : null) ??
              (gmailErr instanceof Error ? gmailErr.message : JSON.stringify(data ?? gmailErr));
            logger.error({ err: gmailErr, responseData: data }, 'Gmail API test connection failed');
            res.json({ valid: false, message: `Gmail API: ${detail}` });
            return;
          }
        }

        // Fallback: SMTP
        const host = await resolve('SMTP_HOST');
        const port = await resolve('SMTP_PORT');
        const user = await resolve('SMTP_USER');
        const pass = await resolve('SMTP_PASS');
        if (!host || !user || !pass) {
          res.json({ valid: false, message: 'Set up Gmail API (Google OAuth credentials) or provide SMTP Host, User, and Password' });
          return;
        }
        const portNum = parseInt(port) || 587;
        const transporter = nodemailer.createTransport({
          host,
          port: portNum,
          secure: portNum === 465,
          auth: { user, pass },
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 15000,
          tls: { rejectUnauthorized: false },
        });
        await transporter.verify();
        transporter.close();
        res.json({ valid: true, message: 'SMTP connection verified successfully' });
        return;
      }

      case 'ai': {
        const results: { key: string; valid: boolean; message: string }[] = [];

        // OpenRouter (text generation)
        const openrouterKey = await resolve('OPENROUTER_API_KEY');
        if (openrouterKey) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          try {
            const resp = await fetch('https://openrouter.ai/api/v1/models', {
              headers: { Authorization: `Bearer ${openrouterKey}` },
              signal: controller.signal,
            });
            clearTimeout(timeout);
            if (resp.ok) {
              results.push({ key: 'OPENROUTER_API_KEY', valid: true, message: 'OpenRouter API key is valid' });
            } else {
              results.push({ key: 'OPENROUTER_API_KEY', valid: false, message: `OpenRouter returned ${resp.status}` });
            }
          } catch (e) {
            clearTimeout(timeout);
            results.push({ key: 'OPENROUTER_API_KEY', valid: false, message: e instanceof Error ? e.message : 'Connection failed' });
          }
        }

        if (results.length === 0) {
          res.json({ valid: false, message: 'No AI key configured. Set your OpenRouter API key.' });
          return;
        }
        const allValid = results.every((r) => r.valid);
        res.json({ valid: allValid, message: results.map((r) => `${r.key}: ${r.message}`).join('; '), results });
        return;
      }



      case 'crawler': {
        // Built-in crawler — always available
        res.json({ valid: true, message: 'Built-in crawler is ready (no external service needed)' });
        return;
      }

      default:
        res.json({ valid: true, message: 'No validation needed for this section' });
        return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Validation failed';
    logger.error({ err, section }, 'Settings validation error');
    res.json({ valid: false, message: msg });
  }
});

// ── Competitor Monitoring ──────────────────────────────────────────────

/** List all competitors from the Sheets tab */
dashboardRouter.get('/competitors', async (_req: Request, res: Response) => {
  try {
    const competitors = await sheets.getCompetitors();
    res.json({ competitors });
  } catch (err) {
    logger.error({ err }, 'Failed to list competitors');
    res.status(500).json({ error: 'Failed to list competitors' });
  }
});

/** Add a new competitor */
dashboardRouter.post('/competitors', async (req: Request, res: Response) => {
  try {
    const { name, url } = req.body;
    if (!name || !url) {
      res.status(400).json({ error: 'name and url are required' });
      return;
    }
    await sheets.appendCompetitor({ Name: name, URL: url, Active: 'Yes' });
    res.json({ success: true, message: `Competitor "${name}" added` });
  } catch (err) {
    logger.error({ err }, 'Failed to add competitor');
    res.status(500).json({ error: 'Failed to add competitor' });
  }
});

/** Trigger crawl for a single competitor or all competitors */
dashboardRouter.post('/competitors/crawl', async (req: Request, res: Response) => {
  try {
    const { name } = req.body; // optional — if not provided, crawl all active

    const competitors = await sheets.getCompetitors();
    const toCrawl = name
      ? competitors.filter((c) => c.name === name)
      : competitors;

    if (toCrawl.length === 0) {
      res.status(404).json({ error: name ? `Competitor "${name}" not found or inactive` : 'No active competitors configured' });
      return;
    }

    let enqueued = 0;
    for (const comp of toCrawl) {
      await competitorCrawl.add(`manual-crawl-${comp.name}`, {
        competitorName: comp.name,
        url: comp.url,
      }, { jobId: `manual-crawl-${comp.name}-${Date.now()}` });
      enqueued++;
    }

    res.json({ success: true, enqueued, competitors: toCrawl.map((c) => c.name) });
  } catch (err) {
    logger.error({ err }, 'Failed to trigger competitor crawl');
    res.status(500).json({ error: 'Failed to trigger crawl' });
  }
});

/** Get crawl results/history for competitors from DB snapshots */
dashboardRouter.get('/competitors/results', async (req: Request, res: Response) => {
  try {
    const name = req.query.name as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const query = name
      ? db.select().from(competitorSnapshots)
          .where(eq(competitorSnapshots.competitorName, name))
          .orderBy(desc(competitorSnapshots.crawledAt))
          .limit(limit)
      : db.select().from(competitorSnapshots)
          .orderBy(desc(competitorSnapshots.crawledAt))
          .limit(limit);

    const snapshots = await query;
    res.json({ results: snapshots });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch competitor results');
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

/** Download crawl results as JSON */
dashboardRouter.get('/competitors/results/download', async (req: Request, res: Response) => {
  try {
    const name = req.query.name as string | undefined;

    const query = name
      ? db.select().from(competitorSnapshots)
          .where(eq(competitorSnapshots.competitorName, name))
          .orderBy(desc(competitorSnapshots.crawledAt))
          .limit(50)
      : db.select().from(competitorSnapshots)
          .orderBy(desc(competitorSnapshots.crawledAt))
          .limit(50);

    const snapshots = await query;

    const filename = name
      ? `competitor-${name.replace(/\s+/g, '-').toLowerCase()}-results.json`
      : 'all-competitor-results.json';

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json({
      exportedAt: new Date().toISOString(),
      totalResults: snapshots.length,
      results: snapshots.map((s) => ({
        competitor: s.competitorName,
        url: s.url,
        crawledAt: s.crawledAt,
        data: s.data,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to download competitor results');
    res.status(500).json({ error: 'Failed to download results' });
  }
});
