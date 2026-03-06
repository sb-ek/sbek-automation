import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { logger } from '../config/logger.js';

// ── Interfaces ──────────────────────────────────────────────────────

export interface CrawlProduct {
  name: string;
  price: number;
  currency: string;
  category?: string;
  url?: string;
}

export interface CrawlResult {
  url: string;
  title: string;
  products: CrawlProduct[];
  meta: {
    description?: string;
    keywords?: string[];
    ogImage?: string;
    ogTitle?: string;
    canonical?: string;
  };
  techSeo: {
    hasSchema: boolean;
    schemaTypes: string[];
    h1Tags: string[];
    h2Tags: string[];
    hasOpenGraph: boolean;
    hasSitemap: boolean;
    robotsTxt: string;
  };
  links: string[];
  pageCount: number;
  crawledAt: string;
}

// ── Stealth helpers ─────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/** Apply stealth patches to a Puppeteer page to evade bot detection. */
async function applyStealthPatches(page: Page): Promise<void> {
  // Override navigator.webdriver
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // Override chrome runtime
  await page.evaluateOnNewDocument(() => {
    (window as unknown as Record<string, unknown>).chrome = {
      runtime: {},
      loadTimes: () => ({}),
      csi: () => ({}),
      app: { isInstalled: false },
    };
  });

  // Override permissions query
  await page.evaluateOnNewDocument(() => {
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (params: PermissionDescriptor) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: 'denied', onchange: null } as PermissionStatus);
      }
      return originalQuery(params);
    };
  });

  // Override plugins length
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
  });

  // Override languages
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-IN', 'en-US', 'en'],
    });
  });

  // Pass WebGL vendor/renderer check
  await page.evaluateOnNewDocument(() => {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param: number) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, param);
    };
  });
}

// ── Service ─────────────────────────────────────────────────────────

class CrawlerService {
  private browser: Browser | null = null;

  /** Get or launch a shared Chromium browser instance. */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser;

    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    this.browser = await puppeteer.launch({
      headless: true,
      ...(execPath ? { executablePath: execPath } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1920,1080',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--lang=en-IN,en',
        '--single-process',
      ],
    });

    logger.info('Puppeteer browser launched');
    return this.browser;
  }

  /**
   * Crawl a competitor site and extract structured data.
   * Strategy: Puppeteer headless browser first (bypasses Cloudflare/bot protection),
   * with cheerio fallback for simple HTTP fetch.
   */
  async analyzeSite(url: string, _previousCrawl?: Record<string, unknown>): Promise<CrawlResult> {
    logger.info({ url }, 'Starting site crawl');

    const baseUrl = new URL(url).origin;

    // Try headless browser first, fallback to plain fetch
    let mainPageHtml: string;
    try {
      mainPageHtml = await this.fetchWithBrowser(url);
    } catch (browserErr) {
      logger.warn({ url, err: String(browserErr) }, 'Browser fetch failed — trying plain HTTP fallback');
      try {
        mainPageHtml = await this.fetchPlain(url);
      } catch (plainErr) {
        logger.warn({ url, err: String(plainErr) }, 'All fetch methods failed — returning minimal result');
        return {
          url,
          title: `Failed to crawl: ${String(plainErr)}`,
          products: [],
          meta: {},
          techSeo: { hasSchema: false, schemaTypes: [], h1Tags: [], h2Tags: [], hasOpenGraph: false, hasSitemap: false, robotsTxt: '' },
          links: [],
          pageCount: 0,
          crawledAt: new Date().toISOString(),
        };
      }
    }

    const $ = cheerio.load(mainPageHtml);

    const title = $('title').text().trim();
    const meta = this.extractMeta($);
    const techSeo = this.extractTechSeo($);

    // Collect internal links for deeper crawl
    const internalLinks = this.extractInternalLinks($, baseUrl);

    // Find product/collection pages (max 5 sub-pages)
    const productPages = internalLinks
      .filter((l) => /\/(product|shop|collection|jewel|ring|necklace|earring|bracelet|pendant|category)/i.test(l))
      .slice(0, 5);

    const allProducts: CrawlProduct[] = [];

    // Extract products from main page
    allProducts.push(...this.extractProducts($, baseUrl));

    // Crawl sub-pages
    const subPageResults = await this.crawlSubPages(productPages, baseUrl);
    for (const result of subPageResults) {
      allProducts.push(...result.products);
    }

    // Deduplicate products by name
    const uniqueProducts = this.deduplicateProducts(allProducts);

    // Check sitemap and robots.txt (plain fetch is fine for these)
    techSeo.hasSitemap = await this.checkUrl(`${baseUrl}/sitemap.xml`);
    techSeo.robotsTxt = await this.fetchText(`${baseUrl}/robots.txt`);

    const crawlResult: CrawlResult = {
      url,
      title,
      products: uniqueProducts,
      meta,
      techSeo,
      links: internalLinks.slice(0, 50),
      pageCount: 1 + subPageResults.length,
      crawledAt: new Date().toISOString(),
    };

    logger.info(
      { url, productsFound: uniqueProducts.length, pagesScraped: crawlResult.pageCount },
      'Site crawl completed',
    );

    return crawlResult;
  }

  /** Health check — always healthy since this is built-in. */
  async getHealth(): Promise<{ status: string }> {
    return { status: 'ok' };
  }

  /** Close the browser (for graceful shutdown). */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // ── Fetch strategies ──────────────────────────────────────────────

  /** Fetch a page using a headless Chromium browser — bypasses Cloudflare & JS challenges. */
  private async fetchWithBrowser(url: string): Promise<string> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    try {
      const ua = randomUA();
      await page.setUserAgent(ua);
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
      });

      await applyStealthPatches(page);

      // Navigate with extended timeout — some sites are slow after challenge
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 30_000,
      });

      // Wait a bit for any JS-rendered content to load
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Scroll down to trigger lazy-loaded content
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let totalHeight = 0;
          const distance = 400;
          const timer = setInterval(() => {
            window.scrollBy(0, distance);
            totalHeight += distance;
            if (totalHeight >= document.body.scrollHeight || totalHeight > 5000) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      });

      // Wait for any lazy content triggered by scroll
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const html = await page.content();

      // Check if we got a Cloudflare challenge page
      if (html.includes('Just a moment...') || html.includes('cf-browser-verification')) {
        logger.warn({ url }, 'Cloudflare challenge detected — waiting longer');
        await new Promise((resolve) => setTimeout(resolve, 8000));
        const retryHtml = await page.content();
        return retryHtml;
      }

      return html;
    } finally {
      await page.close();
    }
  }

  /** Plain HTTP fetch — fast fallback for sites without bot protection. */
  private async fetchPlain(url: string): Promise<string> {
    const ua = randomUA();
    const parsedUrl = new URL(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8,hi;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': `${parsedUrl.origin}/`,
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1',
          'Sec-CH-UA': '"Chromium";v="131", "Not_A Brand";v="24"',
          'Sec-CH-UA-Mobile': '?0',
          'Sec-CH-UA-Platform': '"Windows"',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'max-age=0',
          'Connection': 'keep-alive',
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── HTML extraction helpers ─────────────────────────────────────

  private extractMeta($: cheerio.CheerioAPI): CrawlResult['meta'] {
    return {
      description: $('meta[name="description"]').attr('content') || undefined,
      keywords: ($('meta[name="keywords"]').attr('content') || '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean) || undefined,
      ogImage: $('meta[property="og:image"]').attr('content') || undefined,
      ogTitle: $('meta[property="og:title"]').attr('content') || undefined,
      canonical: $('link[rel="canonical"]').attr('href') || undefined,
    };
  }

  private extractTechSeo($: cheerio.CheerioAPI): CrawlResult['techSeo'] {
    const schemaTypes: string[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).text());
        if (json['@type']) schemaTypes.push(json['@type']);
        if (Array.isArray(json['@graph'])) {
          json['@graph'].forEach((item: Record<string, string>) => {
            if (item['@type']) schemaTypes.push(item['@type']);
          });
        }
      } catch { /* ignore invalid JSON-LD */ }
    });

    return {
      hasSchema: schemaTypes.length > 0,
      schemaTypes,
      h1Tags: $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean),
      h2Tags: $('h2').map((_, el) => $(el).text().trim()).get().slice(0, 10).filter(Boolean),
      hasOpenGraph: $('meta[property="og:title"]').length > 0,
      hasSitemap: false,
      robotsTxt: '',
    };
  }

  private extractInternalLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
    const links = new Set<string>();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      try {
        const resolved = new URL(href, baseUrl);
        if (resolved.origin === baseUrl) {
          links.add(resolved.pathname);
        }
      } catch { /* skip malformed URLs */ }
    });
    return [...links];
  }

  private extractProducts($: cheerio.CheerioAPI, baseUrl: string): CrawlProduct[] {
    const products: CrawlProduct[] = [];

    // Strategy 1: JSON-LD Product schema
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).text());
        const items = json['@type'] === 'Product' ? [json]
          : Array.isArray(json['@graph'])
            ? json['@graph'].filter((i: Record<string, string>) => i['@type'] === 'Product')
            : [];

        for (const item of items) {
          const price = item.offers?.price || item.offers?.lowPrice || 0;
          products.push({
            name: item.name || '',
            price: parseFloat(price) || 0,
            currency: item.offers?.priceCurrency || 'INR',
            url: item.url || undefined,
          });
        }
      } catch { /* skip */ }
    });

    // Strategy 2: Common e-commerce CSS selectors
    const selectors = [
      '.product-card', '.product-item', '.product', '.wc-block-grid__product',
      '[data-product-id]', '.grid-product', '.productCard', '.product-thumbnail',
      '.product-tile', '.product-grid-item', '.plp-card', '.product-listing',
    ];

    for (const selector of selectors) {
      const found: CrawlProduct[] = [];
      $(selector).each((_, el) => {
        const $el = $(el);
        const name = $el.find('.product-title, .product-name, .woocommerce-loop-product__title, h2, h3, .title, [class*="name"], [class*="title"]').first().text().trim();
        const priceText = $el.find('.price, .product-price, .amount, [class*="price"]').first().text().trim();
        const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
        const link = $el.find('a').first().attr('href');

        if (name && name.length > 2) {
          found.push({
            name,
            price,
            currency: 'INR',
            url: link ? new URL(link, baseUrl).href : undefined,
          });
        }
      });
      if (found.length > 0) {
        products.push(...found);
        break; // use first matching selector
      }
    }

    return products;
  }

  private deduplicateProducts(products: CrawlProduct[]): CrawlProduct[] {
    const seen = new Map<string, CrawlProduct>();
    for (const p of products) {
      const key = p.name.toLowerCase().trim();
      if (key && !seen.has(key)) {
        seen.set(key, p);
      }
    }
    return [...seen.values()];
  }

  // ── Sub-page crawling ────────────────────────────────────────────

  private async crawlSubPages(
    urls: string[],
    baseUrl: string,
  ): Promise<Array<{ url: string; products: CrawlProduct[] }>> {
    const results: Array<{ url: string; products: CrawlProduct[] }> = [];

    // Crawl sub-pages sequentially (2s delay between) to avoid rate limiting
    for (const path of urls) {
      try {
        const fullUrl = `${baseUrl}${path}`;
        let html: string;
        try {
          html = await this.fetchWithBrowser(fullUrl);
        } catch {
          html = await this.fetchPlain(fullUrl);
        }
        const $ = cheerio.load(html);
        results.push({ url: fullUrl, products: this.extractProducts($, baseUrl) });

        // Delay between sub-page crawls to be respectful
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (err) {
        logger.warn({ url: `${baseUrl}${path}`, err: String(err) }, 'Sub-page crawl failed — skipping');
      }
    }

    return results;
  }

  // ── Simple HTTP helpers ───────────────────────────────────────────

  private async fetchText(url: string): Promise<string> {
    try {
      const html = await this.fetchPlain(url);
      return html.slice(0, 2000);
    } catch {
      return '';
    }
  }

  private async checkUrl(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': randomUA() },
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ── Singleton Export ────────────────────────────────────────────────────────

export const crawler = new CrawlerService();
