import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  jobLogs,
  webhookEvents,
  cronRuns,
  competitorSnapshots,
  systemConfig,
} from '../src/db/schema.js';

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6380', {
  maxRetriesPerRequest: null,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(randomBetween(6, 23), randomBetween(0, 59), randomBetween(0, 59));
  return d;
}

function hoursAgo(hours: number): Date {
  const d = new Date();
  d.setTime(d.getTime() - hours * 60 * 60 * 1000);
  return d;
}

// ---------------------------------------------------------------------------
// Data pools
// ---------------------------------------------------------------------------

const customerNames = [
  'Priya Sharma', 'Rahul Mehra', 'Ananya Patel', 'Vikram Singh', 'Neha Gupta',
  'Arjun Reddy', 'Kavita Iyer', 'Sanjay Kapoor', 'Divya Nair', 'Amit Joshi',
  'Pooja Deshmukh', 'Rohan Malhotra', 'Sneha Pillai', 'Karan Thakur', 'Isha Bhatia',
  'Manish Agarwal', 'Ritu Verma', 'Deepak Choudhary', 'Meera Krishnan', 'Aditya Saxena',
];

const products = [
  { name: 'Gold Necklace Set', sku: 'SBEK-GN-001', category: 'Necklaces' },
  { name: 'Diamond Ring', sku: 'SBEK-DR-002', category: 'Rings' },
  { name: 'Kundan Earrings', sku: 'SBEK-KE-003', category: 'Earrings' },
  { name: 'Polki Choker Set', sku: 'SBEK-PC-004', category: 'Necklaces' },
  { name: 'Temple Jewellery Bangles', sku: 'SBEK-TB-005', category: 'Bangles' },
  { name: 'Meenakari Pendant', sku: 'SBEK-MP-006', category: 'Pendants' },
  { name: 'Ruby Studded Maang Tikka', sku: 'SBEK-MT-007', category: 'Hair Accessories' },
  { name: 'Jadau Bridal Set', sku: 'SBEK-JB-008', category: 'Bridal' },
  { name: 'Pearl Jhumka Earrings', sku: 'SBEK-PJ-009', category: 'Earrings' },
  { name: 'Antique Gold Anklet', sku: 'SBEK-GA-010', category: 'Anklets' },
  { name: 'Emerald Cocktail Ring', sku: 'SBEK-ER-011', category: 'Rings' },
  { name: 'Diamond Tennis Bracelet', sku: 'SBEK-DB-012', category: 'Bracelets' },
  { name: 'Solitaire Nose Pin', sku: 'SBEK-SN-013', category: 'Nose Pins' },
  { name: 'Gold Mangalsutra', sku: 'SBEK-GM-014', category: 'Mangalsutra' },
  { name: 'Navratna Necklace', sku: 'SBEK-NN-015', category: 'Necklaces' },
];

const webhookSources: Array<{ source: string; events: string[] }> = [
  { source: 'woocommerce', events: ['order.created', 'order.updated', 'order.completed'] },
  { source: 'stripe', events: ['payment.succeeded', 'order.refunded'] },
];

const queueNames = [
  'order-sync',
  'notification',
  'review-request',
  'content-generation',
  'creative-generation',
  'social-posting',
  'competitor-crawl',
];

const cronJobNames = [
  'order-sync-cron',
  'review-request-cron',
  'competitor-crawl-cron',
  'content-generation-cron',
];

const failedJobErrors = [
  'WooCommerce API timeout after 30000ms',
  'Google Sheets rate limit exceeded — 429 Too Many Requests',
  'WhatsApp message delivery failed: recipient phone unreachable',
  'OpenRouter API error: insufficient credits',
  'DALL-E generation failed: content policy violation',
  'Instagram API: access token expired',
  'Redis connection reset by peer',
  'Puppeteer navigation timeout: competitor site blocked crawler',
  'Stripe webhook signature verification failed',
  'SMTP connection refused: email service down',
];

const competitors = [
  { name: 'Tanishq', url: 'https://www.tanishq.co.in' },
  { name: 'CaratLane', url: 'https://www.caratlane.com' },
  { name: 'Kalyan Jewellers', url: 'https://www.kalyanjewellers.net' },
  { name: 'Malabar Gold', url: 'https://www.malabargoldanddiamonds.com' },
  { name: 'PC Jeweller', url: 'https://www.pcjeweller.com' },
];

const competitorCategories: Record<string, string[]> = {
  Tanishq: ['Gold Jewellery', 'Diamond Jewellery', 'Platinum', 'Solitaires', 'Wedding'],
  CaratLane: ['Rings', 'Earrings', 'Pendants', 'Bracelets', 'Chains'],
  'Kalyan Jewellers': ['Bridal', 'Gold', 'Diamond', 'Antique', 'Polki'],
  'Malabar Gold': ['Gold', 'Diamond', 'Platinum', 'Mine Diamond', 'Era'],
  'PC Jeweller': ['Gold', 'Diamond', 'Solitaire', 'Silver', 'Platinum'],
};

const competitorPromotions: string[][] = [
  ['25% off on diamond making charges', 'Free gold coin on purchases above ₹1,00,000'],
  ['Buy 2 Get 1 on silver jewellery', 'Exchange old gold at best rates'],
  ['Flat 20% off on diamond jewellery', 'EMI starting ₹999/month'],
  ['Akshaya Tritiya special: 10% off on gold', 'Complimentary gift wrapping'],
  ['Festival collection — up to 30% off', 'Lifetime free maintenance'],
];

// ---------------------------------------------------------------------------
// Seed: webhook_events (50 events)
// ---------------------------------------------------------------------------

function generateWebhookEvents(): Array<{
  source: string;
  event: string;
  payload: object;
  processed: boolean;
  processedAt: Date | null;
  createdAt: Date;
}> {
  const events = [];
  for (let i = 0; i < 50; i++) {
    const orderId = 10001 + i;
    const sourceGroup = randomFrom(webhookSources);
    const event = randomFrom(sourceGroup.events);
    const customer = randomFrom(customerNames);
    const product = randomFrom(products);
    const amount = randomBetween(15000, 250000);
    const processed = Math.random() < 0.96;
    const createdAt = daysAgo(randomBetween(0, 6));
    const processedAt = processed
      ? new Date(createdAt.getTime() + randomBetween(500, 30000))
      : null;

    events.push({
      source: sourceGroup.source,
      event,
      payload: {
        orderId,
        orderNumber: `SBEK-${orderId}`,
        customer: {
          name: customer,
          email: `${customer.toLowerCase().replace(' ', '.')}@example.com`,
          phone: `+91${randomBetween(7000000000, 9999999999)}`,
        },
        lineItems: [
          {
            productName: product.name,
            sku: product.sku,
            category: product.category,
            quantity: randomBetween(1, 2),
            price: amount,
          },
        ],
        total: amount,
        currency: 'INR',
        status: event === 'order.completed'
          ? 'completed'
          : event === 'order.refunded'
            ? 'refunded'
            : 'processing',
        paymentMethod: randomFrom(['razorpay', 'stripe', 'cod', 'bank_transfer']),
        shippingAddress: {
          city: randomFrom(['Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai', 'Pune', 'Jaipur', 'Kolkata']),
          state: randomFrom(['Maharashtra', 'Delhi', 'Karnataka', 'Telangana', 'Tamil Nadu', 'Rajasthan', 'West Bengal']),
          pincode: `${randomBetween(100000, 999999)}`,
        },
      },
      processed,
      processedAt,
      createdAt,
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Seed: job_logs (200 entries)
// ---------------------------------------------------------------------------

function generateJobLogs(): Array<{
  queueName: string;
  jobId: string;
  status: string;
  payload: object;
  result: object | null;
  error: string | null;
  attempts: number;
  createdAt: Date;
  completedAt: Date | null;
}> {
  const logs = [];
  for (let i = 0; i < 200; i++) {
    const queueName = randomFrom(queueNames);
    const roll = Math.random();
    let status: string;
    if (roll < 0.88) status = 'completed';
    else if (roll < 0.94) status = 'active';
    else if (roll < 0.97) status = 'failed';
    else status = 'queued';

    const createdAt = daysAgo(randomBetween(0, 2));
    const orderId = randomBetween(10001, 10050);

    let payload: object;
    switch (queueName) {
      case 'order-sync':
        payload = { orderId, action: 'sync_to_sheets' };
        break;
      case 'notification':
        payload = { orderId, channel: randomFrom(['whatsapp', 'email', 'sms']), template: randomFrom(['order_confirmation', 'shipping_update', 'delivery_complete']) };
        break;
      case 'review-request':
        payload = { orderId, customer: randomFrom(customerNames), delayHours: randomBetween(24, 72) };
        break;
      case 'content-generation':
        payload = { type: randomFrom(['product_description', 'blog_post', 'social_caption']), product: randomFrom(products).name };
        break;
      case 'creative-generation':
        payload = { type: randomFrom(['product_image', 'banner', 'story_graphic']), dimensions: randomFrom(['1080x1080', '1200x628', '1080x1920']) };
        break;
      case 'social-posting':
        payload = { platform: randomFrom(['instagram', 'facebook', 'pinterest']), postType: randomFrom(['feed', 'story', 'reel']) };
        break;
      case 'competitor-crawl':
        payload = { competitor: randomFrom(competitors).name, url: randomFrom(competitors).url };
        break;
      default:
        payload = { orderId };
    }

    let result: object | null = null;
    let error: string | null = null;
    let completedAt: Date | null = null;
    let attempts = 1;

    if (status === 'completed') {
      completedAt = new Date(createdAt.getTime() + randomBetween(1000, 120000));
      result = queueName === 'order-sync'
        ? { orderId, synced: true, sheetRow: randomBetween(2, 500) }
        : queueName === 'notification'
          ? { delivered: true, channel: (payload as any).channel, messageId: `msg_${randomBetween(100000, 999999)}` }
          : queueName === 'content-generation'
            ? { generated: true, wordCount: randomBetween(50, 300), model: 'openai/gpt-4o' }
            : queueName === 'creative-generation'
              ? { generated: true, imageUrl: `https://cdn.sbek.com/creatives/gen_${randomBetween(1000, 9999)}.png` }
              : { success: true };
    } else if (status === 'failed') {
      error = randomFrom(failedJobErrors);
      attempts = randomBetween(1, 3);
    } else if (status === 'active') {
      attempts = 1;
    }

    logs.push({
      queueName,
      jobId: `${queueName}-${i}-${randomBetween(1000, 9999)}`,
      status,
      payload,
      result,
      error,
      attempts,
      createdAt,
      completedAt,
    });
  }
  return logs;
}

// ---------------------------------------------------------------------------
// Seed: cron_runs (30 entries)
// ---------------------------------------------------------------------------

function generateCronRuns(): Array<{
  jobName: string;
  startedAt: Date;
  completedAt: Date | null;
  itemsProcessed: number;
  error: string | null;
}> {
  const runs = [];
  for (let i = 0; i < 30; i++) {
    const jobName = randomFrom(cronJobNames);
    const startedAt = daysAgo(randomBetween(0, 4));
    const succeeded = Math.random() < 0.95;
    const duration = randomBetween(2000, 60000);
    const completedAt = succeeded ? new Date(startedAt.getTime() + duration) : null;
    const itemsProcessed = succeeded ? randomBetween(5, 50) : randomBetween(0, 5);
    const error = succeeded
      ? null
      : randomFrom([
          'WooCommerce API timeout after 30000ms',
          'Puppeteer navigation timeout: competitor site blocked crawler',
          'Google Sheets rate limit exceeded — 429 Too Many Requests',
          'ECONNREFUSED: Redis connection failed',
        ]);

    runs.push({ jobName, startedAt, completedAt, itemsProcessed, error });
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Seed: competitor_snapshots (15 entries, 3 per competitor)
// ---------------------------------------------------------------------------

function generateCompetitorSnapshots(): Array<{
  competitorName: string;
  url: string;
  data: object;
  crawledAt: Date;
}> {
  const snapshots = [];
  for (const comp of competitors) {
    const categories = competitorCategories[comp.name];
    const promotions = competitorPromotions[competitors.indexOf(comp)];
    for (let j = 0; j < 3; j++) {
      const crawledAt = daysAgo(randomBetween(0, 13));
      const productCount = randomBetween(500, 5000);
      const minPrice = randomBetween(2000, 10000);
      const maxPrice = randomBetween(500000, 2500000);

      snapshots.push({
        competitorName: comp.name,
        url: comp.url,
        data: {
          productCount,
          priceRange: { min: minPrice, max: maxPrice },
          categories,
          topProducts: [
            { name: `${comp.name} Gold Necklace`, price: randomBetween(30000, 200000), rating: (Math.random() * 1.5 + 3.5).toFixed(1) },
            { name: `${comp.name} Diamond Ring`, price: randomBetween(20000, 150000), rating: (Math.random() * 1.5 + 3.5).toFixed(1) },
            { name: `${comp.name} Bridal Set`, price: randomBetween(100000, 500000), rating: (Math.random() * 1.5 + 3.5).toFixed(1) },
            { name: `${comp.name} Pearl Earrings`, price: randomBetween(5000, 40000), rating: (Math.random() * 1.5 + 3.5).toFixed(1) },
          ],
          promotions,
          lastCrawled: crawledAt.toISOString(),
        },
        crawledAt,
      });
    }
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// Seed: system_config (brand settings)
// ---------------------------------------------------------------------------

function generateSystemConfig(): Array<{ key: string; value: unknown }> {
  return [
    { key: 'brand_name', value: 'SBEK' },
    { key: 'brand_primary_color', value: '#B8860B' },
    { key: 'brand_website', value: 'https://sbek.com' },
    { key: 'brand_support_phone', value: '+919999999999' },
    { key: 'brand_support_email', value: 'support@sbek.com' },
    { key: 'review_url', value: 'https://sbek.com/reviews' },
    { key: 'openrouter_model', value: 'openai/gpt-4o' },
    { key: 'openrouter_image_model', value: 'openai/dall-e-3' },
  ];
}

// ---------------------------------------------------------------------------
// Seed: BullMQ queues
// ---------------------------------------------------------------------------

interface QueueSpec {
  name: string;
  completed: number;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

const queueSpecs: QueueSpec[] = [
  { name: 'order-sync', completed: 45, waiting: 2, active: 1, delayed: 0, failed: 0 },
  { name: 'notification', completed: 78, waiting: 0, active: 3, delayed: 0, failed: 1 },
  { name: 'review-request', completed: 32, waiting: 0, active: 0, delayed: 4, failed: 0 },
  { name: 'content-generation', completed: 28, waiting: 1, active: 2, delayed: 0, failed: 0 },
  { name: 'creative-generation', completed: 19, waiting: 1, active: 1, delayed: 0, failed: 0 },
  { name: 'social-posting', completed: 42, waiting: 0, active: 1, delayed: 0, failed: 0 },
  { name: 'competitor-crawl', completed: 15, waiting: 0, active: 0, delayed: 0, failed: 0 },
];

async function seedQueues() {
  console.log('  Seeding BullMQ queues...');

  for (const spec of queueSpecs) {
    const queue = new Queue(spec.name, { connection });
    let jobIndex = 0;

    // Obliterate existing queue data so demo is clean
    await queue.obliterate({ force: true });

    // Waiting jobs (just add them — they sit in waiting state)
    for (let i = 0; i < spec.waiting; i++) {
      await queue.add('demo-job', {
        demo: true,
        orderId: randomBetween(10001, 10050),
        type: 'waiting',
      }, { jobId: `demo-${spec.name}-w-${jobIndex++}` });
    }

    // Delayed jobs (scheduled for future)
    for (let i = 0; i < spec.delayed; i++) {
      await queue.add('demo-job', {
        demo: true,
        orderId: randomBetween(10001, 10050),
        type: 'delayed',
        scheduledFor: new Date(Date.now() + randomBetween(1, 48) * 60 * 60 * 1000).toISOString(),
      }, {
        jobId: `demo-${spec.name}-d-${jobIndex++}`,
        delay: randomBetween(1, 48) * 60 * 60 * 1000,
      });
    }

    // Completed jobs — add them to be counted
    for (let i = 0; i < spec.completed; i++) {
      await queue.add('demo-job', {
        demo: true,
        orderId: randomBetween(10001, 10050),
        type: 'completed',
      }, { jobId: `demo-${spec.name}-c-${jobIndex++}` });
    }

    // Failed jobs — add them (they will sit in waiting; actual failure needs a worker)
    for (let i = 0; i < spec.failed; i++) {
      await queue.add('demo-job', {
        demo: true,
        orderId: randomBetween(10001, 10050),
        type: 'failed',
        error: randomFrom(failedJobErrors),
      }, { jobId: `demo-${spec.name}-f-${jobIndex++}` });
    }

    // Active jobs — add them (they will sit in waiting; active needs a worker to pick them up)
    for (let i = 0; i < spec.active; i++) {
      await queue.add('demo-job', {
        demo: true,
        orderId: randomBetween(10001, 10050),
        type: 'active',
      }, { jobId: `demo-${spec.name}-a-${jobIndex++}` });
    }

    const total = spec.completed + spec.waiting + spec.active + spec.delayed + spec.failed;
    console.log(`    ${spec.name}: ${total} jobs added`);

    await queue.close();
  }
}

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

async function seed() {
  console.log('=== SBEK Demo Data Seeder ===\n');

  // ---- Clear existing demo data ----
  console.log('Clearing existing data...');
  await db.delete(jobLogs);
  await db.delete(webhookEvents);
  await db.delete(cronRuns);
  await db.delete(competitorSnapshots);
  await db.delete(systemConfig);
  console.log('  Cleared all tables.\n');

  // ---- Seed webhook_events ----
  console.log('Seeding webhook_events (50 events)...');
  const webhookData = generateWebhookEvents();
  await db.insert(webhookEvents).values(webhookData);
  console.log(`  Inserted ${webhookData.length} webhook events.\n`);

  // ---- Seed job_logs ----
  console.log('Seeding job_logs (200 entries)...');
  const jobLogData = generateJobLogs();
  await db.insert(jobLogs).values(jobLogData);
  console.log(`  Inserted ${jobLogData.length} job logs.\n`);

  // ---- Seed cron_runs ----
  console.log('Seeding cron_runs (30 entries)...');
  const cronRunData = generateCronRuns();
  await db.insert(cronRuns).values(cronRunData);
  console.log(`  Inserted ${cronRunData.length} cron runs.\n`);

  // ---- Seed competitor_snapshots ----
  console.log('Seeding competitor_snapshots (15 entries)...');
  const snapshotData = generateCompetitorSnapshots();
  await db.insert(competitorSnapshots).values(snapshotData);
  console.log(`  Inserted ${snapshotData.length} competitor snapshots.\n`);

  // ---- Seed system_config ----
  console.log('Seeding system_config (brand settings)...');
  const configData = generateSystemConfig();
  await db.insert(systemConfig).values(configData);
  console.log(`  Inserted ${configData.length} config entries.\n`);

  // NOTE: BullMQ queues are NOT seeded because the running workers would
  // pick up demo jobs and fail them, creating ugly "failed" counts.
  // Queue stats will show real data once real orders start flowing.
  console.log('Skipping BullMQ queue seeding (workers would fail demo jobs).\n');

  // ---- Done ----
  console.log('=== Demo data seeded successfully! ===');
  await pool.end();
  await connection.quit();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
