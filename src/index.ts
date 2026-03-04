import 'dotenv/config';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { redis } from './config/redis.js';
import { pool, db } from './config/database.js';
import { queues } from './queues/registry.js';
import { sheets } from './services/googlesheets.service.js';
import { initScheduler } from './cron/scheduler.js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Import queue workers so they start processing jobs
import './queues/definitions/order-sync.queue.js';
import './queues/definitions/notification.queue.js';
import './queues/definitions/review-request.queue.js';
import './queues/definitions/content-generation.queue.js';
import './queues/definitions/creative-generation.queue.js';
import './queues/definitions/social-posting.queue.js';
import './queues/definitions/competitor-crawl.queue.js';

// Run database migrations on startup
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
try {
  await migrate(db, { migrationsFolder: resolve(__dirname, 'db/migrations') });
  logger.info('Database migrations completed');
} catch (err) {
  logger.warn({ err }, 'Database migration failed — tables may already exist');
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
