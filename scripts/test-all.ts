import 'dotenv/config';
import { Queue } from 'bullmq';
import type { OrderSyncPayload, CreativeGenerationPayload, CompetitorCrawlPayload, ContentGenerationPayload } from '../src/queues/types.js';

// ─────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
const url = new URL(REDIS_URL);
const connection = {
  host: url.hostname,
  port: Number(url.port) || 6379,
  password: url.password || undefined,
  maxRetriesPerRequest: null as null,
};

const passed: string[] = [];
const failed: string[] = [];
const skipped: string[] = [];

function ok(name: string, detail?: string) {
  passed.push(name);
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name: string, err: string) {
  failed.push(name);
  console.log(`  ❌ ${name} — ${err}`);
}
function skip(name: string, reason: string) {
  skipped.push(name);
  console.log(`  ⏭️  ${name} — ${reason}`);
}

// ─────────────────────────────────────────────────────────────────────
// Test 1: SMTP / Email
// ─────────────────────────────────────────────────────────────────────

async function testEmail() {
  console.log('\n━━━ 1. EMAIL (SMTP) ━━━');
  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    await transporter.verify();
    ok('SMTP Connection', `${process.env.SMTP_HOST}:${process.env.SMTP_PORT}`);

    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || `"SBEK" <${process.env.SMTP_USER}>`,
      to: process.env.SMTP_USER,
      subject: `SBEK Test — All Systems Check (${new Date().toLocaleTimeString()})`,
      html: '<h2>SBEK System Test</h2><p>All systems check passed. This is an automated test email.</p>',
    });
    ok('Send Test Email', `MessageID: ${info.messageId}`);
  } catch (err: any) {
    fail('Email', err.message?.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test 2: Google Sheets
// ─────────────────────────────────────────────────────────────────────

async function testSheets() {
  console.log('\n━━━ 2. GOOGLE SHEETS ━━━');
  try {
    const { sheets } = await import('../src/services/googlesheets.service.js');
    await sheets.init();
    ok('Sheets Connection', `Sheet loaded`);

    // Read competitors
    const competitors = await sheets.getCompetitors();
    ok('Read Competitors', `${competitors.length} competitors found`);

    // Check if we can find orders tab
    const doc = (sheets as any).doc;
    const tabs = doc.sheetsByIndex.map((s: any) => s.title);
    ok('Sheet Tabs', tabs.join(', '));
  } catch (err: any) {
    fail('Google Sheets', err.message?.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test 3: AI Text Generation (OpenRouter)
// ─────────────────────────────────────────────────────────────────────

async function testAIText() {
  console.log('\n━━━ 3. AI TEXT GENERATION (OpenRouter) ━━━');
  try {
    const { openai } = await import('../src/services/openai.service.js');

    // Test basic text generation
    const response = await openai.generateText(
      'You are a helpful assistant.',
      'Say "SBEK test passed" in exactly 3 words.',
      { maxTokens: 50, temperature: 0 },
    );
    ok('Text Generation', `Response: "${response.trim().slice(0, 60)}"`);

    // Test SEO meta generation
    const seo = await openai.generateSEOMeta(
      'Arka Frost Terra Ring',
      'Rings',
      '925 Sterling Silver, Blue Topaz, Handcrafted',
    );
    ok('SEO Meta Generation', `Title: "${seo.title.slice(0, 50)}..."`);
  } catch (err: any) {
    fail('AI Text', err.message?.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test 4: AI Image Generation (OpenRouter)
// ─────────────────────────────────────────────────────────────────────

async function testAIImage() {
  console.log('\n━━━ 4. AI IMAGE GENERATION (OpenRouter) ━━━');
  try {
    const { nanobanana } = await import('../src/services/nanobanana.service.js');

    const result = await nanobanana.generateAndSave(
      'Generate a product photo of a gold ring with diamond on white background, jewelry e-commerce style',
      `test-all-${Date.now()}`,
      { aspectRatio: '1:1' },
    );

    ok('Image Generation', `${result.filePath.split('/').slice(-2).join('/')} (${Math.round(result.buffer.length / 1024)}KB)`);
  } catch (err: any) {
    const msg = err.message || JSON.stringify(err);
    fail('Image Generation', msg.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test 5: WooCommerce API
// ─────────────────────────────────────────────────────────────────────

async function testWooCommerce() {
  console.log('\n━━━ 5. WOOCOMMERCE API ━━━');
  try {
    const { woocommerce } = await import('../src/services/woocommerce.service.js');

    const products = await woocommerce.listProducts({ per_page: 3, status: 'publish' });
    ok('Fetch Products', `${products.length} products retrieved`);

    if (products.length > 0) {
      ok('Product Data', `First: "${(products[0] as any).name}" (ID: ${(products[0] as any).id})`);
    }

    ok('Store Connected', `sb-ek.com is accessible`);
  } catch (err: any) {
    fail('WooCommerce', err.message?.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test 6: Redis / BullMQ Queues
// ─────────────────────────────────────────────────────────────────────

async function testRedis() {
  console.log('\n━━━ 6. REDIS / QUEUES ━━━');
  try {
    const { default: Redis } = await import('ioredis');
    const redis = new Redis({
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password || undefined,
      maxRetriesPerRequest: null,
    });
    const pong = await redis.ping();
    ok('Redis Connection', `PONG received`);
    await redis.quit();
  } catch (err: any) {
    fail('Redis', err.message?.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test 7: Full Order Pipeline (enqueue → Sheets + Email)
// ─────────────────────────────────────────────────────────────────────

async function testOrderPipeline() {
  console.log('\n━━━ 7. ORDER PIPELINE (end-to-end) ━━━');
  console.log('  Enqueuing test order #88888...');
  try {
    const orderSyncQueue = new Queue<OrderSyncPayload>('order-sync', { connection });

    const fakeOrder = {
      id: 88888,
      status: 'processing',
      currency: 'INR',
      total: '8500.00',
      date_created: new Date().toISOString(),
      date_modified: new Date().toISOString(),
      payment_method: 'razorpay',
      payment_method_title: 'Razorpay',
      customer_id: 1,
      billing: {
        first_name: 'Test',
        last_name: 'Customer',
        email: process.env.SMTP_USER || 'aryansbudukh@gmail.com',
        phone: '+919999999999',
        address_1: '456 Test Road',
        city: 'Mumbai',
        state: 'MH',
        postcode: '400001',
        country: 'IN',
      },
      shipping: {
        first_name: 'Test',
        last_name: 'Customer',
        address_1: '456 Test Road',
        city: 'Mumbai',
        state: 'MH',
        postcode: '400001',
        country: 'IN',
      },
      line_items: [
        {
          id: 1,
          name: 'Luna Crescent Pendant',
          product_id: 23505,
          variation_id: 0,
          quantity: 1,
          total: '8500.00',
          sku: 'SBEK-LCP-001',
          meta_data: [
            { id: 1, key: '_metal_type', value: '925 Sterling Silver' },
            { id: 2, key: '_stone_type', value: 'Moonstone' },
          ],
          attributes: [],
        },
      ],
      customer_note: 'Full system test',
      meta_data: [],
    };

    await orderSyncQueue.add(`order-${fakeOrder.id}`, {
      orderId: fakeOrder.id,
      event: 'order.created',
      rawPayload: fakeOrder as unknown as Record<string, unknown>,
    }, {
      jobId: `test-all-order-${fakeOrder.id}-${Date.now()}`,
    });

    ok('Order Enqueued', `#88888 — Luna Crescent Pendant, ₹8,500`);
    console.log('  → Worker will: add to Google Sheets + send confirmation email');

    await orderSyncQueue.close();
  } catch (err: any) {
    fail('Order Pipeline', err.message?.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test 8: Content Generation (enqueue SEO + FAQ + Caption job)
// ─────────────────────────────────────────────────────────────────────

async function testContentGeneration() {
  console.log('\n━━━ 8. AI CONTENT PIPELINE (enqueue) ━━━');
  try {
    const contentQueue = new Queue<ContentGenerationPayload>('content-generation', { connection });

    await contentQueue.add('content-test', {
      productId: 23504,
      productName: 'Arka Frost Terra Ring',
      category: 'Rings',
      description: 'A stunning handcrafted ring in 925 Sterling Silver with Blue Topaz',
      types: ['seo', 'faq', 'caption'],
    } as any, {
      jobId: `test-all-content-${Date.now()}`,
    });

    ok('Content Job Enqueued', 'SEO + FAQ + Caption for Arka Frost Terra');
    console.log('  → Worker will: generate SEO meta, 5 FAQs, Instagram caption');

    await contentQueue.close();
  } catch (err: any) {
    fail('Content Generation', err.message?.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test 9: Creative/Image Pipeline (enqueue 1 product)
// ─────────────────────────────────────────────────────────────────────

async function testCreativePipeline() {
  console.log('\n━━━ 9. CREATIVE/IMAGE PIPELINE (enqueue) ━━━');
  try {
    const creativeQueue = new Queue<CreativeGenerationPayload>('creative-generation', { connection });

    await creativeQueue.add('creative-test', {
      productId: 23504,
      productName: 'Arka Frost Terra Ring',
      productDescription: 'Handcrafted 925 Sterling Silver ring with Blue Topaz stone',
      productImageUrl: '',
      category: 'Rings',
      variants: ['white_bg'],
    } as any, {
      jobId: `test-all-creative-${Date.now()}`,
    });

    ok('Creative Job Enqueued', '1 variant (white_bg) for Arka Frost Terra');
    console.log('  → Worker will: generate AI image + save to Drive + log in Sheets');

    await creativeQueue.close();
  } catch (err: any) {
    fail('Creative Pipeline', err.message?.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test 10: Competitor Crawl (enqueue 1 competitor)
// ─────────────────────────────────────────────────────────────────────

async function testCompetitorCrawl() {
  console.log('\n━━━ 10. COMPETITOR CRAWL (enqueue) ━━━');
  try {
    const crawlQueue = new Queue<CompetitorCrawlPayload>('competitor-crawl', { connection });

    await crawlQueue.add('crawl-test', {
      competitorName: 'CaratLane',
      url: 'https://www.caratlane.com',
    }, {
      jobId: `test-all-crawl-${Date.now()}`,
    });

    ok('Crawl Job Enqueued', 'CaratLane — caratlane.com');
    console.log('  → Worker will: crawl site + AI analysis + store snapshot');
    console.log('  ⚠️  Note: Needs crawler microservice running (CRAWLER_BASE_URL)');

    await crawlQueue.close();
  } catch (err: any) {
    fail('Competitor Crawl', err.message?.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Run All
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║       SBEK AUTOMATION — FULL SYSTEM TEST      ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`Time: ${new Date().toLocaleString()}`);

  // Direct tests (verify services work)
  await testEmail();
  await testSheets();
  await testAIText();
  await testAIImage();
  await testWooCommerce();
  await testRedis();

  // Queue-based tests (enqueue jobs for workers to process)
  await testOrderPipeline();
  await testContentGeneration();
  await testCreativePipeline();
  await testCompetitorCrawl();

  // Summary
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║                  RESULTS                       ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`  ✅ Passed:  ${passed.length}`);
  console.log(`  ❌ Failed:  ${failed.length}`);
  if (skipped.length) console.log(`  ⏭️  Skipped: ${skipped.length}`);

  if (failed.length > 0) {
    console.log('\n  Failed tests:');
    for (const f of failed) console.log(`    • ${f}`);
  }

  console.log('\n━━━ WHAT TO CHECK ━━━');
  console.log('  1. Gmail inbox     → 2 emails (test + order confirmation)');
  console.log('  2. Google Sheet    → new order row (#88888) in Orders tab');
  console.log('  3. Dashboard       → all queued jobs at http://localhost:3000');
  console.log('  4. Generated image → creatives/generated/ folder');
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
