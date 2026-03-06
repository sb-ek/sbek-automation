import 'dotenv/config';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { redis } from './config/redis.js';
import { pool } from './config/database.js';
import { queues } from './queues/registry.js';
import { sheets } from './services/googlesheets.service.js';
import { initScheduler } from './cron/scheduler.js';

// Import queue workers so they start processing jobs
import './queues/definitions/order-sync.queue.js';
import './queues/definitions/notification.queue.js';
import './queues/definitions/review-request.queue.js';
import './queues/definitions/content-generation.queue.js';
import './queues/definitions/creative-generation.queue.js';
import './queues/definitions/competitor-crawl.queue.js';

// Run database migrations on startup — create tables if they don't exist
try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "system_config" (
      "id" serial PRIMARY KEY NOT NULL,
      "key" varchar(100) NOT NULL,
      "value" jsonb NOT NULL,
      "updated_at" timestamp DEFAULT now(),
      CONSTRAINT "system_config_key_unique" UNIQUE("key")
    );
    CREATE TABLE IF NOT EXISTS "webhook_events" (
      "id" serial PRIMARY KEY NOT NULL,
      "source" varchar(50) NOT NULL,
      "event" varchar(100) NOT NULL,
      "payload" jsonb NOT NULL,
      "processed" boolean DEFAULT false,
      "processed_at" timestamp,
      "created_at" timestamp DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "job_logs" (
      "id" serial PRIMARY KEY NOT NULL,
      "queue_name" varchar(100) NOT NULL,
      "job_id" varchar(100) NOT NULL,
      "status" text DEFAULT 'queued' NOT NULL,
      "payload" jsonb,
      "result" jsonb,
      "error" text,
      "attempts" integer DEFAULT 0,
      "created_at" timestamp DEFAULT now(),
      "completed_at" timestamp
    );
    CREATE TABLE IF NOT EXISTS "cron_runs" (
      "id" serial PRIMARY KEY NOT NULL,
      "job_name" varchar(100) NOT NULL,
      "started_at" timestamp DEFAULT now(),
      "completed_at" timestamp,
      "items_processed" integer DEFAULT 0,
      "error" text
    );
    CREATE TABLE IF NOT EXISTS "competitor_snapshots" (
      "id" serial PRIMARY KEY NOT NULL,
      "competitor_name" varchar(200) NOT NULL,
      "url" varchar(500) NOT NULL,
      "data" jsonb NOT NULL,
      "crawled_at" timestamp DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS "notification_logs" (
      "id" serial PRIMARY KEY NOT NULL,
      "order_id" integer,
      "recipient_name" varchar(200),
      "recipient_email" varchar(200),
      "recipient_phone" varchar(50),
      "channel" varchar(20) NOT NULL,
      "template_name" varchar(100) NOT NULL,
      "status" varchar(20) NOT NULL DEFAULT 'sent',
      "error" text,
      "sent_at" timestamp DEFAULT now()
    );

    -- Performance indexes for common queries
    CREATE INDEX IF NOT EXISTS "idx_job_logs_queue" ON "job_logs" ("queue_name");
    CREATE INDEX IF NOT EXISTS "idx_job_logs_status" ON "job_logs" ("status");
    CREATE INDEX IF NOT EXISTS "idx_webhook_events_processed" ON "webhook_events" ("processed");
    CREATE INDEX IF NOT EXISTS "idx_webhook_events_created" ON "webhook_events" ("created_at");
    CREATE INDEX IF NOT EXISTS "idx_competitor_snapshots_name" ON "competitor_snapshots" ("competitor_name");
    CREATE INDEX IF NOT EXISTS "idx_competitor_snapshots_crawled" ON "competitor_snapshots" ("crawled_at");
    CREATE INDEX IF NOT EXISTS "idx_cron_runs_job" ON "cron_runs" ("job_name");
    CREATE INDEX IF NOT EXISTS "idx_notification_logs_order" ON "notification_logs" ("order_id");
    CREATE INDEX IF NOT EXISTS "idx_notification_logs_sent" ON "notification_logs" ("sent_at");
  `);
  logger.info('Database tables ensured');
} catch (err) {
  logger.error({ err }, 'Failed to create database tables');
}

const app = createApp();

// Initialize Google Sheets connection (await so cron jobs don't race)
try {
  await sheets.init();
  logger.info('Google Sheets initialized');
} catch (err) {
  logger.warn({ err }, 'Google Sheets init failed — will retry on first use');
}

// Start cron scheduler
initScheduler();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'SBEK Automation server started');
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Received shutdown signal, draining...');

  // Force exit after 15 seconds to prevent hanging
  const forceTimer = setTimeout(() => {
    logger.warn('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 15_000);
  forceTimer.unref();

  server.close(() => {
    logger.info('HTTP server closed');
  });

  try {
    await queues.closeAll();
    logger.info('All queues closed');
  } catch (err) {
    logger.error({ err }, 'Error closing queues');
  }

  try {
    await redis.quit();
    logger.info('Redis connection closed');
  } catch (err) {
    logger.error({ err }, 'Error closing Redis');
  }

  try {
    await pool.end();
    logger.info('PostgreSQL pool closed');
  } catch (err) {
    logger.error({ err }, 'Error closing PostgreSQL pool');
  }

  try {
    const { crawler } = await import('./services/crawler.service.js');
    await crawler.close();
    logger.info('Crawler browser closed');
  } catch { /* ignore if not started */ }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception — shutting down');
  process.exit(1);
});
