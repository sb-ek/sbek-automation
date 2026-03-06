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
  `);
  logger.info('Database tables ensured');
} catch (err) {
  logger.error({ err }, 'Failed to create database tables');
}

const app = createApp();

// Initialize Google Sheets connection
sheets.init().catch((err) => {
  logger.warn({ err }, 'Google Sheets init failed — will retry on first use');
});

// Start cron scheduler
initScheduler();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'SBEK Automation server started');
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Received shutdown signal, draining...');

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
