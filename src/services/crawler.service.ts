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

    // Find product/collection pages (max 8 sub-pages)
    const productPages = internalLinks
      .filter((l) => /\/(product|shop|collection|jewel|ring|necklace|earring|bracelet|pendant|category|catalog|bangles|chains|mangalsutra|gold|diamond|silver|platinum|solitaire|engagement|wedding|gift|new-arrival|best-seller|trending|offers)/i.test(l))
      .slice(0, 8);

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
  private async fetchWithBrowser(url: string, retryCount = 0): Promise<string> {
    let browser: Browser;
    try {
      browser = await this.getBrowser();
    } catch (launchErr) {
      // Browser launch failed — kill stale instance and retry once
      logger.warn({ err: String(launchErr) }, 'Browser launch failed — resetting');
      this.browser = null;
      if (retryCount < 1) {
        return this.fetchWithBrowser(url, retryCount + 1);
      }
      throw launchErr;
    }

    const page = await browser.newPage();

    // Hard timeout for the entire page operation — prevents infinite hangs
    const pageTimeout = setTimeout(() => {
      page.close().catch(() => {});
    }, 55_000);

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

      // Wait for JS-rendered content (SPAs need more time)
      await new Promise((resolve) => setTimeout(resolve, 2500));

      // Try to wait for common product container selectors
      try {
        await page.waitForSelector(
          '.product-card, .product-item, .product, [class*="ProductCard"], [class*="productCard"], [class*="product-card"], [class*="plp-product"], [class*="catalog-product"], [itemtype*="Product"]',
          { timeout: 5000 },
        );
      } catch {
        // No product selectors found — that's okay, we'll try other extraction methods
      }

      // Scroll down to trigger lazy-loaded content (more aggressive for jewelry SPAs)
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let totalHeight = 0;
          const distance = 500;
          let iterations = 0;
          const timer = setInterval(() => {
            window.scrollBy(0, distance);
            totalHeight += distance;
            iterations++;
            if (totalHeight >= document.body.scrollHeight || totalHeight > 8000 || iterations > 25) {
              clearInterval(timer);
              resolve();
            }
          }, 120);
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 1200));

      const html = await page.content();

      // Check if we got a Cloudflare challenge page
      if (html.includes('Just a moment...') || html.includes('cf-browser-verification')) {
        logger.info({ url }, 'Cloudflare challenge detected — waiting for resolution');
        await new Promise((resolve) => setTimeout(resolve, 6000));
        const retryHtml = await page.content();

        // If still blocked, try one more time with different approach
        if (retryHtml.includes('Just a moment...')) {
          logger.warn({ url }, 'Cloudflare challenge still present after wait');
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return await page.content();
        }

        return retryHtml;
      }

      return html;
    } catch (err) {
      // If browser disconnected mid-crawl, reset and propagate
      if (String(err).includes('Protocol error') || String(err).includes('Target closed') || String(err).includes('disconnected')) {
        logger.warn({ url, err: String(err) }, 'Browser disconnected — resetting');
        this.browser = null;
      }
      throw err;
    } finally {
      clearTimeout(pageTimeout);
      await page.close().catch(() => {});
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

    // Strategy 1: JSON-LD Product schema (most reliable)
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).text());
        const candidates = json['@type'] === 'Product' ? [json]
          : json['@type'] === 'ItemList' && Array.isArray(json.itemListElement)
            ? json.itemListElement.map((i: Record<string, unknown>) => i.item || i).filter((i: Record<string, string>) => i['@type'] === 'Product')
          : Array.isArray(json['@graph'])
            ? json['@graph'].filter((i: Record<string, string>) => i['@type'] === 'Product')
            : [];

        for (const item of candidates) {
          const offers = item.offers;
          const price = offers?.price || offers?.lowPrice
            || (Array.isArray(offers) ? offers[0]?.price : 0) || 0;
          products.push({
            name: item.name || '',
            price: parseFloat(String(price)) || 0,
            currency: offers?.priceCurrency || (Array.isArray(offers) ? offers[0]?.priceCurrency : 'INR') || 'INR',
            url: item.url || undefined,
          });
        }
      } catch { /* skip invalid JSON-LD */ }
    });

    // Strategy 2: Common e-commerce CSS selectors (broad set covering Indian jewelry sites)
    const selectors = [
      // Generic e-commerce
      '.product-card', '.product-item', '.product', '.wc-block-grid__product',
      '[data-product-id]', '.grid-product', '.productCard', '.product-thumbnail',
      '.product-tile', '.product-grid-item', '.plp-card', '.product-listing',
      // Tanishq / Titan
      '.product-list-item', '.product-box', '.product_box', '.product-info',
      '[class*="ProductCard"]', '[class*="productCard"]', '[class*="product-card"]',
      '[class*="ProductTile"]', '[class*="productTile"]', '[class*="product-tile"]',
      '[class*="ProductItem"]', '[class*="product-item"]',
      // CaratLane / BlueStone
      '[class*="plp-product"]', '[class*="plp_product"]', '[class*="PLPProduct"]',
      '[class*="search-product"]', '[class*="catalog-product"]',
      '.product-collection-item', '.collection-product',
      // Generic card patterns
      '[class*="card"][class*="product"]', '[class*="item"][class*="product"]',
      '[data-testid*="product"]', '[data-component*="product"]',
      // Image grid fallback (many jewelry sites use image grids)
      '.product-grid > div', '.products-grid > div', '.product-list > div',
      '[class*="ProductGrid"] > div', '[class*="productGrid"] > div',
    ];

    // Name selectors — broad to catch custom class names
    const nameSelectors = [
      '.product-title', '.product-name', '.woocommerce-loop-product__title',
      'h2', 'h3', 'h4',
      '.title', '.name',
      '[class*="name"]', '[class*="title"]', '[class*="Name"]', '[class*="Title"]',
      '[class*="product-name"]', '[class*="productName"]',
      'a[title]', // many sites put product name in link title attr
    ].join(', ');

    // Price selectors
    const priceSelectors = [
      '.price', '.product-price', '.amount',
      '[class*="price"]', '[class*="Price"]',
      '[class*="cost"]', '[class*="Cost"]',
      '[class*="mrp"]', '[class*="MRP"]',
      '[class*="offer"]',
    ].join(', ');

    for (const selector of selectors) {
      const found: CrawlProduct[] = [];
      $(selector).each((_, el) => {
        const $el = $(el);
        // Try name from selectors, then from link title attribute
        let name = $el.find(nameSelectors).first().text().trim();
        if (!name) {
          name = $el.find('a[title]').attr('title')?.trim() || '';
        }
        if (!name) {
          name = $el.find('img[alt]').attr('alt')?.trim() || '';
        }

        const priceText = $el.find(priceSelectors).first().text().trim();
        const price = this.parseIndianPrice(priceText);
        const link = $el.find('a').first().attr('href') || $el.closest('a').attr('href');

        if (name && name.length > 2 && name.length < 300) {
          found.push({
            name,
            price,
            currency: 'INR',
            url: link ? (() => { try { return new URL(link, baseUrl).href; } catch { return undefined; } })() : undefined,
          });
        }
      });
      if (found.length >= 2) { // need at least 2 matches to trust the selector
        products.push(...found);
        break;
      }
    }

    // Strategy 3: If nothing found yet, try micro-data (itemprop)
    if (products.length === 0) {
      $('[itemtype*="schema.org/Product"], [itemtype*="Product"]').each((_, el) => {
        const $el = $(el);
        const name = $el.find('[itemprop="name"]').first().text().trim();
        const priceText = $el.find('[itemprop="price"]').first().text().trim() || $el.find('[itemprop="price"]').attr('content') || '';
        const price = this.parseIndianPrice(priceText);
        const url = $el.find('[itemprop="url"]').attr('href') || $el.find('a').first().attr('href');

        if (name && name.length > 2) {
          products.push({
            name,
            price,
            currency: 'INR',
            url: url ? (() => { try { return new URL(url, baseUrl).href; } catch { return undefined; } })() : undefined,
          });
        }
      });
    }

    return products;
  }

  /** Parse Indian price format: ₹1,23,456.00 → 123456 */
  private parseIndianPrice(text: string): number {
    if (!text) return 0;
    // Remove currency symbols, spaces, and commas, keep digits and decimal
    const cleaned = text.replace(/[₹$€£\s,]/g, '').replace(/[^0-9.]/g, '');
    return parseFloat(cleaned) || 0;
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

    // Crawl sub-pages sequentially (1.5s delay between) to avoid rate limiting
    for (const path of urls) {
      try {
        const fullUrl = `${baseUrl}${path}`;
        let html: string;
        try {
          html = await this.fetchWithBrowser(fullUrl);
        } catch {
          try {
            html = await this.fetchPlain(fullUrl);
          } catch {
            logger.warn({ url: fullUrl }, 'Sub-page fetch failed — skipping');
            continue;
          }
        }
        const $ = cheerio.load(html);
        const subProducts = this.extractProducts($, baseUrl);
        results.push({ url: fullUrl, products: subProducts });
        logger.debug({ url: fullUrl, productsFound: subProducts.length }, 'Sub-page crawled');

        // Delay between sub-page crawls to be respectful
        await new Promise((resolve) => setTimeout(resolve, 1500));
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
