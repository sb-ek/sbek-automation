import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inArray } from 'drizzle-orm';
import {
  jobLogs,
  webhookEvents,
  cronRuns,
  competitorSnapshots,
  systemConfig,
} from '../db/schema.js';
import { logger } from '../config/logger.js';
import { CONFIGURABLE_KEYS } from './settings.service.js';

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
// Generators
// ---------------------------------------------------------------------------

function generateWebhookEvents() {
  const events = [];
  for (let i = 0; i < 50; i++) {
    const orderId = 10001 + i;
    const sourceGroup = randomFrom(webhookSources);
    const event = randomFrom(sourceGroup.events);
    const customer = randomFrom(customerNames);
    const product = randomFrom(products);
    const amount = randomBetween(15000, 250000);
    const processed = Math.random() < 0.98;
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

function generateJobLogs() {
  const logs = [];
  for (let i = 0; i < 200; i++) {
    const queueName = randomFrom(queueNames);
    const roll = Math.random();
    let status: string;
    if (roll < 0.92) status = 'completed';
    else if (roll < 0.96) status = 'active';
    else if (roll < 0.98) status = 'failed';
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

function generateCronRuns() {
  const runs = [];
  for (let i = 0; i < 30; i++) {
    const jobName = randomFrom(cronJobNames);
    const startedAt = daysAgo(randomBetween(0, 4));
    const succeeded = Math.random() < 0.97;
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

function generateCompetitorSnapshots() {
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

function generateSystemConfig() {
  return [
    { key: 'brand_name', value: 'SBEK' },
    { key: 'brand_primary_color', value: '#B8860B' },
    { key: 'brand_website', value: 'https://sbek.com' },
    { key: 'brand_support_phone', value: '+919999999999' },
    { key: 'brand_support_email', value: 'support@sbek.com' },
    { key: 'review_url', value: 'https://sbek.com/reviews' },
    { key: 'openrouter_model', value: 'google/gemini-2.5-flash' },
    { key: 'openrouter_image_model', value: 'google/gemini-3-pro-image-preview' },
  ];
}

// ---------------------------------------------------------------------------
// Main seed function — uses the app's own db connection
// ---------------------------------------------------------------------------

export async function seedDemoData(db: NodePgDatabase<any>): Promise<string> {
  logger.info('Seeding demo data (inline)...');

  // Clear existing demo data (preserve user-configured API keys)
  await db.delete(jobLogs);
  await db.delete(webhookEvents);
  await db.delete(cronRuns);
  await db.delete(competitorSnapshots);

  // Only delete non-credential config entries — preserve user API keys/secrets
  const demoConfigKeys = generateSystemConfig().map((c) => c.key);
  const safeToDelete = demoConfigKeys.filter((k) => !(CONFIGURABLE_KEYS as readonly string[]).includes(k));
  if (safeToDelete.length > 0) {
    await db.delete(systemConfig).where(inArray(systemConfig.key, safeToDelete));
  }

  // Insert fresh demo data
  const webhookData = generateWebhookEvents();
  await db.insert(webhookEvents).values(webhookData);

  const jobLogData = generateJobLogs();
  await db.insert(jobLogs).values(jobLogData);

  const cronRunData = generateCronRuns();
  await db.insert(cronRuns).values(cronRunData);

  const snapshotData = generateCompetitorSnapshots();
  await db.insert(competitorSnapshots).values(snapshotData);

  const configData = generateSystemConfig();
  // Use onConflictDoNothing to preserve any user-set values
  for (const entry of configData) {
    await db.insert(systemConfig).values(entry).onConflictDoNothing().catch(() => {});
  }

  const summary = `Seeded: ${webhookData.length} webhook events, ${jobLogData.length} job logs, ${cronRunData.length} cron runs, ${snapshotData.length} competitor snapshots, ${configData.length} config entries`;
  logger.info(summary);
  return summary;
}
