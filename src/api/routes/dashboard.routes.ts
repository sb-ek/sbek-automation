import { Router, type Request, type Response } from 'express';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { queues, orderSync, competitorCrawl } from '../../queues/registry.js';
import { db } from '../../config/database.js';
import { pool } from '../../config/database.js';
import { redis } from '../../config/redis.js';
import { jobLogs, webhookEvents, cronRuns, competitorSnapshots, notificationLogs } from '../../db/schema.js';
import { desc, eq, count, gte, sql, and, countDistinct } from 'drizzle-orm';
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

    // ── Trend data: time-windowed queries ──
    const now = new Date();
    const h24ago = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const h48ago = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const d7ago = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const d14ago = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    // Completed jobs in the last 24h vs previous 24h
    const [completedLast24hRows] = await db
      .select({ cnt: count() })
      .from(jobLogs)
      .where(and(eq(jobLogs.status, 'completed'), gte(jobLogs.completedAt, h24ago)));
    const [completedPrev24hRows] = await db
      .select({ cnt: count() })
      .from(jobLogs)
      .where(and(eq(jobLogs.status, 'completed'), gte(jobLogs.completedAt, h48ago), sql`${jobLogs.completedAt} < ${h24ago}`));

    // Completed jobs in the last 7d vs previous 7d
    const [completedLast7dRows] = await db
      .select({ cnt: count() })
      .from(jobLogs)
      .where(and(eq(jobLogs.status, 'completed'), gte(jobLogs.completedAt, d7ago)));
    const [completedPrev7dRows] = await db
      .select({ cnt: count() })
      .from(jobLogs)
      .where(and(eq(jobLogs.status, 'completed'), gte(jobLogs.completedAt, d14ago), sql`${jobLogs.completedAt} < ${d7ago}`));

    // Failed jobs in the last 24h vs previous 24h
    const [failedLast24hRows] = await db
      .select({ cnt: count() })
      .from(jobLogs)
      .where(and(eq(jobLogs.status, 'failed'), gte(jobLogs.completedAt, h24ago)));
    const [failedPrev24hRows] = await db
      .select({ cnt: count() })
      .from(jobLogs)
      .where(and(eq(jobLogs.status, 'failed'), gte(jobLogs.completedAt, h48ago), sql`${jobLogs.completedAt} < ${h24ago}`));

    // Notification queue completed jobs (last 7 days)
    const [notifRows] = await db
      .select({ cnt: count() })
      .from(jobLogs)
      .where(and(eq(jobLogs.queueName, 'notification'), eq(jobLogs.status, 'completed'), gte(jobLogs.completedAt, d7ago)));

    // Distinct competitors crawled this week
    const [compRows] = await db
      .select({ cnt: countDistinct(competitorSnapshots.competitorName) })
      .from(competitorSnapshots)
      .where(gte(competitorSnapshots.crawledAt, d7ago));

    const completedLast24h = Number(completedLast24hRows?.cnt ?? 0);
    const completedPrev24h = Number(completedPrev24hRows?.cnt ?? 0);
    const completedLast7d = Number(completedLast7dRows?.cnt ?? 0);
    const completedPrev7d = Number(completedPrev7dRows?.cnt ?? 0);
    const failedLast24h = Number(failedLast24hRows?.cnt ?? 0);
    const failedPrev24h = Number(failedPrev24hRows?.cnt ?? 0);
    const notificationsSent = Number(notifRows?.cnt ?? 0);
    const competitorsCrawled = Number(compRows?.cnt ?? 0);

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
      completedLast24h,
      completedPrev24h,
      completedLast7d,
      completedPrev7d,
      failedLast24h,
      failedPrev24h,
      notificationsSent,
      competitorsCrawled,
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

/**
 * POST /dashboard/woocommerce/register-webhooks
 * Auto-register order webhooks (order.created, order.updated, order.deleted).
 * Uses ensureWebhooks() which is idempotent — safe to call repeatedly.
 */
dashboardRouter.post('/woocommerce/register-webhooks', async (req: Request, res: Response) => {
  try {
    // Allow optional base URL override from request body
    const baseUrl = (req.body.base_url as string) || undefined;
    const result = await woocommerce.ensureWebhooks(baseUrl);
    res.json({
      success: true,
      registered: result.registered,
      existing: result.existing,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to register webhooks';
    logger.error({ err }, 'ensureWebhooks dashboard error');
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

      case 'whatsapp-interakt': {
        const interaktKey = await resolve('INTERAKT_API_KEY');
        if (!interaktKey) {
          res.json({ valid: false, message: 'Interakt API Key is required' });
          return;
        }
        // Verify the key by calling Interakt's track endpoint (lightweight)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(
          'https://api.interakt.ai/v1/public/track/users/',
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${interaktKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              phoneNumber: '0000000000',
              countryCode: '+91',
              traits: { name: 'SBEK Test' },
            }),
            signal: controller.signal,
          },
        );
        clearTimeout(timeout);
        if (resp.status === 401 || resp.status === 403) {
          res.json({ valid: false, message: 'Invalid Interakt API key — check your credentials' });
          return;
        }
        res.json({ valid: true, message: 'Interakt API key verified' });
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

/** Download crawl results as PDF report */
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

    if (snapshots.length === 0) {
      res.status(404).json({ error: name ? `No crawl results for "${name}" — crawl this competitor first` : 'No crawl results found — run a crawl first' });
      return;
    }

    let generateCompetitorReport: typeof import('../../utils/competitor-report.js').generateCompetitorReport;
    try {
      const mod = await import('../../utils/competitor-report.js');
      generateCompetitorReport = mod.generateCompetitorReport;
    } catch (importErr) {
      logger.error({ importErr }, 'Failed to load competitor-report module — rebuild may be needed');
      res.status(500).json({ error: 'PDF report module not available — the server may need a rebuild' });
      return;
    }

    const filename = name
      ? `SBEK-Competitor-Report-${name.replace(/\s+/g, '-')}.pdf`
      : 'SBEK-Competitor-Analysis-Report.pdf';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = generateCompetitorReport(snapshots, name);
    doc.on('error', (pdfErr: Error) => {
      logger.error({ pdfErr }, 'PDF stream error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'PDF generation failed' });
      }
    });
    doc.pipe(res);
  } catch (err) {
    logger.error({ err }, 'Failed to generate competitor report');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate report' });
    }
  }
});

// ── Email Templates ───────────────────────────────────────────────────────

/** List all email templates with metadata */
dashboardRouter.get('/email-templates', async (_req: Request, res: Response) => {
  try {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    // Try multiple possible template directories
    const possibleDirs = [
      resolve(process.cwd(), 'src/templates/email'),
      resolve(process.cwd(), 'dist/templates/email'),
      resolve(process.cwd(), 'templates/email'),
    ];

    let templateDir = '';
    for (const dir of possibleDirs) {
      try {
        readdirSync(dir);
        templateDir = dir;
        break;
      } catch { /* try next */ }
    }

    if (!templateDir) {
      res.json({ templates: [] });
      return;
    }

    const files = readdirSync(templateDir).filter((f: string) => f.endsWith('.hbs'));
    const templates = files.map((file: string) => {
      const name = file.replace('.hbs', '');
      const html = readFileSync(resolve(templateDir, file), 'utf-8');

      // Extract variable placeholders like {{variable_name}}
      const vars = [...new Set(
        (html.match(/\{\{(?!#|\/|>|!)([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g) || [])
          .map((m: string) => m.replace(/\{\{|\}\}/g, ''))
          .filter((v: string) => !['if', 'else', 'each', 'unless', 'with'].includes(v))
      )];

      // Determine category
      const isInternal = ['production-brief', 'qc-failed-alert', 'competitor-alert', 'price-alert'].includes(name);

      return {
        name,
        displayName: name.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        category: isInternal ? 'internal' : 'customer',
        variables: vars,
        htmlLength: html.length,
      };
    });

    res.json({ templates });
  } catch (err) {
    logger.error({ err }, 'Failed to list email templates');
    res.json({ templates: [] });
  }
});

/** Get rendered preview of an email template */
dashboardRouter.get('/email-templates/:name/preview', async (req: Request, res: Response) => {
  try {
    const { email } = await import('../../services/email.service.js');
    const templateName = req.params.name as string;

    // Sample data for preview
    const sampleData: Record<string, string> = {
      customer_name: 'Priya Sharma',
      order_id: 'SBEK-2026-0042',
      product_name: 'Royal Heritage Gold Necklace',
      amount: '₹1,85,000',
      order_date: '6 Mar 2026',
      delivery_date: '20 Mar 2026',
      carrier_name: 'BlueDart',
      tracking_number: 'BD9876543210',
      tracking_url: '#',
      ship_date: '15 Mar 2026',
      ring_size: '16',
      metal_type: '22K Gold',
      engraving: 'With Love',
      due_date: '18 Mar 2026',
      qc_passed: '12',
      qc_total: '12',
      review_url: '#',
      support_phone: '+919876543210',
      competitor_name: 'Tanishq',
      crawl_date: '6 Mar 2026',
      products_found: '41',
      pages_scraped: '7',
      price_range: '₹15,000 - ₹4,50,000',
      seo_score: '7/10',
      analysis: 'Tanishq continues to dominate with aggressive pricing in the mid-range segment. New festive collection detected with 15 new products.',
      changes_detected: 'New festive collection launched with competitive pricing.',
      alert_date: '6 Mar 2026',
      change_count: '3',
      summary: 'Competitor has made 3 significant price changes. Review recommended.',
      competitor_url: 'https://www.tanishq.co.in',
      failed_items: 'Stone alignment check, Polish uniformity',
    };

    const rendered = await email.renderTemplate(templateName, sampleData);
    if (!rendered) {
      res.status(404).json({ error: `Template "${templateName}" not found` });
      return;
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(rendered);
  } catch (err) {
    logger.error({ err, template: req.params.name }, 'Failed to render email template preview');
    res.status(500).json({ error: 'Failed to render template' });
  }
});

/** Send a test email with a specific template */
dashboardRouter.post('/email-templates/:name/test', async (req: Request, res: Response) => {
  try {
    const { email: emailService } = await import('../../services/email.service.js');
    const templateName = req.params.name as string;
    const { to } = req.body as { to?: string };

    const adminEmail = (await settings.get('ADMIN_EMAIL')) || to;
    if (!adminEmail) {
      res.status(400).json({ error: 'No recipient email — set ADMIN_EMAIL in Settings or pass "to" in body' });
      return;
    }

    const sampleData: Record<string, string> = {
      customer_name: 'Test Customer',
      order_id: 'SBEK-TEST-001',
      product_name: 'Sample Gold Necklace',
      amount: '₹1,50,000',
      order_date: new Date().toLocaleDateString('en-IN'),
      delivery_date: '2 weeks from now',
      competitor_name: 'Test Competitor',
      crawl_date: new Date().toLocaleDateString('en-IN'),
      products_found: '25',
      pages_scraped: '5',
      price_range: '₹10,000 - ₹5,00,000',
      seo_score: '8/10',
      analysis: 'This is a test email preview.',
      changes_detected: '',
    };

    await emailService.sendEmail(
      adminEmail,
      `[TEST] SBEK Email Template: ${templateName}`,
      templateName,
      sampleData,
    );

    res.json({ sent: true, to: adminEmail });
  } catch (err) {
    logger.error({ err }, 'Failed to send test email');
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

// ── SEO / AEO ─────────────────────────────────────────────────────────────

/** Get all SEO/AEO configuration data */
dashboardRouter.get('/seo', async (_req: Request, res: Response) => {
  try {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    // Load schema templates
    const schemaDirs = [
      resolve(process.cwd(), 'seo/schema-templates'),
      resolve(process.cwd(), 'dist/../seo/schema-templates'),
    ];
    const schemas: Array<{ name: string; content: unknown }> = [];
    for (const dir of schemaDirs) {
      try {
        const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'));
        for (const file of files) {
          const content = JSON.parse(readFileSync(resolve(dir, file), 'utf-8'));
          schemas.push({ name: file.replace('.json', ''), content });
        }
        break;
      } catch { /* try next */ }
    }

    // Load prompts
    const promptDirs = [
      resolve(process.cwd(), 'seo/prompts'),
      resolve(process.cwd(), 'dist/../seo/prompts'),
    ];
    const prompts: Array<{ name: string; content: string }> = [];
    for (const dir of promptDirs) {
      try {
        const files = readdirSync(dir).filter((f: string) => f.endsWith('.txt'));
        for (const file of files) {
          const content = readFileSync(resolve(dir, file), 'utf-8');
          prompts.push({ name: file.replace('.txt', ''), content });
        }
        break;
      } catch { /* try next */ }
    }

    // Content pipeline types
    const contentTypes = [
      { type: 'seo_meta', label: 'SEO Meta Tags', description: 'AI-generated title & description pushed to Yoast/RankMath fields on WooCommerce products' },
      { type: 'faq', label: 'FAQ Generation', description: 'Generates 5 FAQ pairs per product with JSON-LD schema markup injected into product page' },
      { type: 'aeo_kb', label: 'AEO Knowledge Base', description: 'Brand knowledge pages optimized for AI engines (ChatGPT, Gemini, Perplexity)' },
      { type: 'comparison', label: 'Comparison Articles', description: '800-1200 word fair comparison articles published as blog posts' },
      { type: 'schema_inject', label: 'Schema Injection', description: 'Product + Organization JSON-LD structured data injected into product pages' },
      { type: 'internal_links', label: 'Internal Linking', description: 'Related products and category browsing sections appended to product descriptions' },
    ];

    res.json({ schemas, prompts, contentTypes });
  } catch (err) {
    logger.error({ err }, 'Failed to load SEO data');
    res.json({ schemas: [], prompts: [], contentTypes: [] });
  }
});

/** SEO/AEO per-product status — checks which products have SEO meta fields populated */
dashboardRouter.get('/seo/products', async (req: Request, res: Response) => {
  try {
    const page = Number(req.query.page) || 1;
    const perPage = Math.min(Number(req.query.per_page) || 20, 100);

    // Fetch products from WooCommerce
    const products = await woocommerce.listProducts({ per_page: perPage, page, status: 'publish' });

    const SEO_KEYS = ['_yoast_wpseo_title', '_yoast_wpseo_metadesc', '_sbek_faq_json_ld', '_sbek_schema_json_ld'];

    const productStatuses = products.map((p) => {
      const meta = p.meta_data ?? [];
      const getMeta = (key: string) => meta.find((m) => m.key === key)?.value || '';

      const seoTitle = getMeta('_yoast_wpseo_title');
      const seoDesc = getMeta('_yoast_wpseo_metadesc');
      const faqJsonLd = getMeta('_sbek_faq_json_ld');
      const schemaJsonLd = getMeta('_sbek_schema_json_ld');
      const hasFaqHtml = (p.description || '').includes('class="sbek-faq"');
      const hasInternalLinks = (p.description || '').includes('sbek-related-products');

      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        image: p.images?.[0]?.src ?? null,
        price: p.price,
        seo: {
          title: seoTitle || null,
          description: seoDesc || null,
          hasMeta: !!(seoTitle && seoDesc),
        },
        faq: {
          hasJsonLd: !!faqJsonLd,
          hasHtml: hasFaqHtml,
          count: faqJsonLd ? (JSON.parse(faqJsonLd)?.mainEntity?.length ?? 0) : 0,
        },
        schema: {
          hasJsonLd: !!schemaJsonLd,
        },
        internalLinks: hasInternalLinks,
      };
    });

    // Summary stats
    const total = productStatuses.length;
    const withSeoMeta = productStatuses.filter((p) => p.seo.hasMeta).length;
    const withFaq = productStatuses.filter((p) => p.faq.hasJsonLd).length;
    const withSchema = productStatuses.filter((p) => p.schema.hasJsonLd).length;
    const withInternalLinks = productStatuses.filter((p) => p.internalLinks).length;

    res.json({
      products: productStatuses,
      stats: { total, withSeoMeta, withFaq, withSchema, withInternalLinks },
      page,
      perPage,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch SEO product statuses');
    res.json({ products: [], stats: { total: 0, withSeoMeta: 0, withFaq: 0, withSchema: 0, withInternalLinks: 0 }, page: 1, perPage: 20 });
  }
});

/** Recent content-pipeline job activity */
dashboardRouter.get('/seo/activity', async (_req: Request, res: Response) => {
  try {
    const recentJobs = await db
      .select()
      .from(jobLogs)
      .where(eq(jobLogs.queueName, 'content-generation'))
      .orderBy(desc(jobLogs.createdAt))
      .limit(30);

    res.json({ jobs: recentJobs });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch SEO activity');
    res.json({ jobs: [] });
  }
});

// ── Notification History ──────────────────────────────────────────────────

dashboardRouter.get('/notifications/history', async (req: Request, res: Response) => {
  try {
    const orderIdParam = req.query.orderId as string | undefined;

    const query = orderIdParam
      ? db.select().from(notificationLogs)
          .where(eq(notificationLogs.orderId, Number(orderIdParam)))
          .orderBy(desc(notificationLogs.sentAt))
          .limit(100)
      : db.select().from(notificationLogs)
          .orderBy(desc(notificationLogs.sentAt))
          .limit(100);

    const notifications = await query;
    res.json({ notifications });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch notification history');
    res.status(500).json({ error: 'Failed to fetch notification history' });
  }
});
