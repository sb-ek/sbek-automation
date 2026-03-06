import {
  pgTable,
  serial,
  varchar,
  text,
  jsonb,
  integer,
  boolean,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// jobLogs — tracks every BullMQ job through its lifecycle
// ---------------------------------------------------------------------------
export const jobLogs = pgTable('job_logs', {
  id: serial('id').primaryKey(),
  queueName: varchar('queue_name', { length: 100 }).notNull(),
  jobId: varchar('job_id', { length: 100 }).notNull(),
  status: text('status').notNull().default('queued'), // queued | active | completed | failed | retrying
  payload: jsonb('payload'),
  result: jsonb('result'),
  error: text('error'),
  attempts: integer('attempts').default(0),
  createdAt: timestamp('created_at').defaultNow(),
  completedAt: timestamp('completed_at'),
});

// ---------------------------------------------------------------------------
// webhookEvents — inbound webhook payloads (e.g. WooCommerce, Stripe)
// ---------------------------------------------------------------------------
export const webhookEvents = pgTable('webhook_events', {
  id: serial('id').primaryKey(),
  source: varchar('source', { length: 50 }).notNull(),   // e.g. 'woocommerce'
  event: varchar('event', { length: 100 }).notNull(),     // e.g. 'order.created'
  payload: jsonb('payload').notNull(),
  processed: boolean('processed').default(false),
  processedAt: timestamp('processed_at'),
  createdAt: timestamp('created_at').defaultNow(),
});

// ---------------------------------------------------------------------------
// cronRuns — audit log for every scheduled cron execution
// ---------------------------------------------------------------------------
export const cronRuns = pgTable('cron_runs', {
  id: serial('id').primaryKey(),
  jobName: varchar('job_name', { length: 100 }).notNull(),
  startedAt: timestamp('started_at').defaultNow(),
  completedAt: timestamp('completed_at'),
  itemsProcessed: integer('items_processed').default(0),
  error: text('error'),
});

// ---------------------------------------------------------------------------
// competitorSnapshots — point-in-time competitor page data
// ---------------------------------------------------------------------------
export const competitorSnapshots = pgTable('competitor_snapshots', {
  id: serial('id').primaryKey(),
  competitorName: varchar('competitor_name', { length: 200 }).notNull(),
  url: varchar('url', { length: 500 }).notNull(),
  data: jsonb('data').notNull(),
  crawledAt: timestamp('crawled_at').defaultNow(),
});

// ---------------------------------------------------------------------------
// systemConfig — key-value configuration store
// ---------------------------------------------------------------------------
export const systemConfig = pgTable('system_config', {
  id: serial('id').primaryKey(),
  key: varchar('key', { length: 100 }).notNull().unique(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ---------------------------------------------------------------------------
// notificationLogs — tracks every notification sent to customers
// ---------------------------------------------------------------------------
export const notificationLogs = pgTable('notification_logs', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id'),
  recipientName: varchar('recipient_name', { length: 200 }),
  recipientEmail: varchar('recipient_email', { length: 200 }),
  recipientPhone: varchar('recipient_phone', { length: 50 }),
  channel: varchar('channel', { length: 20 }).notNull(), // 'email', 'whatsapp', 'both'
  templateName: varchar('template_name', { length: 100 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('sent'), // 'sent', 'failed', 'pending'
  error: text('error'),
  sentAt: timestamp('sent_at').defaultNow(),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types (Select = read, Insert = write)
// ---------------------------------------------------------------------------

// jobLogs
export type JobLog = InferSelectModel<typeof jobLogs>;
export type NewJobLog = InferInsertModel<typeof jobLogs>;

// webhookEvents
export type WebhookEvent = InferSelectModel<typeof webhookEvents>;
export type NewWebhookEvent = InferInsertModel<typeof webhookEvents>;

// cronRuns
export type CronRun = InferSelectModel<typeof cronRuns>;
export type NewCronRun = InferInsertModel<typeof cronRuns>;

// competitorSnapshots
export type CompetitorSnapshot = InferSelectModel<typeof competitorSnapshots>;
export type NewCompetitorSnapshot = InferInsertModel<typeof competitorSnapshots>;

// systemConfig
export type SystemConfig = InferSelectModel<typeof systemConfig>;
export type NewSystemConfig = InferInsertModel<typeof systemConfig>;

// notificationLogs
export type NotificationLog = InferSelectModel<typeof notificationLogs>;
export type NewNotificationLog = InferInsertModel<typeof notificationLogs>;
