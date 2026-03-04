import { Router, type Request, type Response } from 'express';
import { webhookAuth } from '../middleware/webhookAuth.js';
import { webhookLimiter } from '../middleware/rateLimiter.js';
import { orderSync, contentGeneration, creativeGeneration } from '../../queues/registry.js';
import { logger } from '../../config/logger.js';
import { db } from '../../config/database.js';
import { webhookEvents } from '../../db/schema.js';

export const webhooksRouter = Router();

// All webhook routes get rate limiting + signature verification
webhooksRouter.use(webhookLimiter);

/**
 * WooCommerce order webhook handler.
 * Receives order.created and order.updated events.
 * Verifies signature, enqueues job, and returns 200 immediately.
 */
webhooksRouter.post(
  '/woocommerce/order',
  webhookAuth,
  async (req: Request, res: Response) => {
    try {
      const topic = req.headers['x-wc-webhook-topic'] as string;
      const webhookId = req.headers['x-wc-webhook-id'] as string;
      const payload = req.body;

      // WooCommerce sends a ping on webhook creation/save — acknowledge it.
      // Pings may have no topic, or topic 'action.woocommerce_webhook_payload',
      // or body with just webhook_id (no order data).
      if (!topic || topic === 'action.woocommerce_webhook_payload' || (!payload?.id && payload?.webhook_id)) {
        logger.info({ topic, webhookId }, 'WooCommerce webhook ping acknowledged');
        res.json({ received: true, type: 'ping' });
        return;
      }

      const orderId = payload?.id;
      if (!orderId) {
        logger.warn({ topic, webhookId }, 'Webhook received without order ID');
        res.status(400).json({ error: 'Missing order ID' });
        return;
      }

      const event = topic === 'order.created' ? 'order.created' as const : 'order.updated' as const;

      // Enqueue for async processing
      await orderSync.add(
        `order-${orderId}-${event}`,
        {
          orderId,
          event,
          rawPayload: payload,
        },
        {
          // Deduplicate rapid webhook fires for the same order+event
          jobId: `order-${orderId}-${event}`,
          // Delay order.updated so order.created finishes first (prevents duplicate rows)
          delay: event === 'order.updated' ? 5000 : 0,
        }
      );

      // Log to webhook_events for dashboard activity feed
      await db.insert(webhookEvents).values({
        source: 'woocommerce',
        event,
        payload: { orderId, customer: payload?.billing?.first_name, total: payload?.total },
        processed: false,
      }).catch((err) => { logger.warn({ err }, 'Failed to log webhook event to DB'); });

      logger.info({ orderId, event, webhookId }, 'Order webhook enqueued');
      res.json({ received: true, orderId, event });
    } catch (err) {
      logger.error({ err }, 'Failed to process order webhook');
      // Still return 200 to prevent WooCommerce from retrying
      // The error is logged and we'll handle it via monitoring
      res.json({ received: true, error: 'Processing failed, logged for retry' });
    }
  }
);

/**
 * WooCommerce product webhook handler.
 * Receives product.created and product.updated events.
 * Auto-triggers SEO content generation and ad creative generation.
 */
webhooksRouter.post(
  '/woocommerce/product',
  webhookAuth,
  async (req: Request, res: Response) => {
    try {
      const topic = req.headers['x-wc-webhook-topic'] as string;
      const payload = req.body;
      const productId = payload?.id;
      const productName = payload?.name || '';

      if (!productId) {
        res.status(400).json({ error: 'Missing product ID' });
        return;
      }

      // Only enqueue jobs for published products
      const status = payload?.status || '';
      if (status !== 'publish') {
        logger.info({ productId, topic, status }, 'Product webhook received — skipping non-published product');
        res.json({ received: true, productId, topic, skipped: true });
        return;
      }

      logger.info({ productId, productName, topic }, 'Product webhook received — enqueuing automation jobs');

      const jobs: Promise<unknown>[] = [];

      // 1. SEO meta generation
      jobs.push(
        contentGeneration.add(`seo-${productId}-webhook`, {
          productId,
          productName,
          type: 'seo_meta',
        }),
      );

      // 2. FAQ generation
      jobs.push(
        contentGeneration.add(`faq-${productId}-webhook`, {
          productId,
          productName,
          type: 'faq',
        }),
      );

      // 3. AEO knowledge base
      jobs.push(
        contentGeneration.add(`aeo-${productId}-webhook`, {
          productId,
          productName,
          type: 'aeo_kb',
        }),
      );

      // 4. Comparison article
      jobs.push(
        contentGeneration.add(`comparison-${productId}-webhook`, {
          productId,
          productName,
          type: 'comparison',
        }),
      );

      // 5. Schema injection
      jobs.push(
        contentGeneration.add(`schema-${productId}-webhook`, {
          productId,
          productName,
          type: 'schema_inject',
        }),
      );

      // 6. Internal linking
      jobs.push(
        contentGeneration.add(`intlink-${productId}-webhook`, {
          productId,
          productName,
          type: 'internal_links',
        }),
      );

      // 7. Ad creative generation (all 5 variants)
      const description = payload?.short_description || payload?.description || '';
      const category = payload?.categories?.[0]?.name || 'Jewelry';
      const imageUrl = payload?.images?.[0]?.src || '';

      jobs.push(
        creativeGeneration.add(`creative-${productId}-webhook`, {
          productId,
          productName,
          productDescription: description.replace(/<[^>]*>/g, '').slice(0, 500),
          productImageUrl: imageUrl,
          category,
          variants: ['white_bg', 'lifestyle', 'festive', 'minimal_text', 'story_format'],
        }),
      );

      await Promise.all(jobs);

      // Log to webhook_events for dashboard activity feed
      await db.insert(webhookEvents).values({
        source: 'woocommerce',
        event: topic || 'product.updated',
        payload: { productId, productName, jobsEnqueued: jobs.length },
        processed: false,
      }).catch((err) => { logger.warn({ err }, 'Failed to log webhook event to DB'); });

      logger.info({ productId, productName, jobCount: jobs.length }, 'Product webhook jobs enqueued');
      res.json({ received: true, productId, topic, jobsEnqueued: jobs.length });
    } catch (err) {
      logger.error({ err }, 'Failed to process product webhook');
      res.json({ received: true, error: 'Processing failed' });
    }
  }
);
