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

export type CrawlDifficulty = 'easy' | 'hard' | 'blocked';

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
  /** How difficult this site is to crawl — 'easy' (no protection), 'hard' (has challenges but resolved), 'blocked' (could not bypass) */
  crawlDifficulty: CrawlDifficulty;
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

// ── Known product listing paths for Indian jewelry competitors ──────

const KNOWN_PRODUCT_PATHS: Record<string, string[]> = {
  'tanishq.co.in': ['/jewellery/all.html', '/jewellery/gold.html', '/jewellery/diamond.html', '/collections', '/jewellery/rings.html', '/jewellery/earrings.html'],
  'caratlane.com': ['/jewellery.html', '/rings.html', '/earrings.html', '/necklaces.html', '/bracelets.html', '/bangles.html'],
  'bluestone.com': ['/jewellery.html', '/rings.html', '/earrings.html', '/pendants.html', '/bangles-bracelets.html'],
  'kalyanjewellers.net': ['/gold-jewellery-designs.php', '/diamond-jewellery-designs.php', '/brands/buy-online-jewellery-candere.php'],
  'melorra.com': ['/jewellery', '/earrings', '/rings', '/necklaces', '/bracelets', '/bangles'],
  'pngjewellers.com': ['/collections/all', '/collections/gold-jewellery', '/collections/diamond-jewellery', '/collections/rings', '/collections/earrings'],
};

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
    const hostname = new URL(url).hostname.replace('www.', '');

    // Try headless browser first, fallback to plain fetch
    let mainPageHtml: string;
    let crawlDifficulty: CrawlDifficulty = 'easy';
    try {
      mainPageHtml = await this.fetchWithBrowser(url);
    } catch (browserErr) {
      const errMsg = String(browserErr);
      // If bot protection blocked us, mark as blocked and return early
      if (errMsg.includes('Bot protection blocked')) {
        logger.warn({ url }, 'Site has heavy bot protection — marking as blocked');
        return {
          url,
          title: 'Bot protection blocked crawl',
          products: [],
          meta: {},
          techSeo: { hasSchema: false, schemaTypes: [], h1Tags: [], h2Tags: [], hasOpenGraph: false, hasSitemap: false, robotsTxt: '' },
          links: [],
          pageCount: 0,
          crawledAt: new Date().toISOString(),
          crawlDifficulty: 'blocked',
        };
      }
      logger.warn({ url, err: errMsg }, 'Browser fetch failed — trying plain HTTP fallback');
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
          crawlDifficulty: 'blocked',
        };
      }
    }

    logger.info({ url, htmlLength: mainPageHtml.length }, 'Main page fetched');

    // Detect if the site has bot protection markers (even if we got through)
    if (mainPageHtml.includes('cf-browser-verification') || mainPageHtml.includes('challenge-platform') ||
        mainPageHtml.includes('__cf_chl_opt') || mainPageHtml.includes('cloudflare') ||
        mainPageHtml.includes('akamai') || mainPageHtml.includes('datadome') ||
        mainPageHtml.includes('perimeterx') || mainPageHtml.includes('imperva')) {
      crawlDifficulty = 'hard';
      logger.info({ url }, 'Site has bot protection markers — marking as hard crawl');
    }

    const $ = cheerio.load(mainPageHtml);

    const title = $('title').text().trim();
    const meta = this.extractMeta($);
    const techSeo = this.extractTechSeo($);

    // Collect internal links for deeper crawl
    const internalLinks = this.extractInternalLinks($, baseUrl);

    // Find product/collection pages — combine link discovery with known paths
    const linkDiscovered = internalLinks
      .filter((l) => /\/(product|shop|collection|jewel|ring|necklace|earring|bracelet|pendant|category|catalog|bangles|chains|mangalsutra|gold|diamond|silver|platinum|solitaire|engagement|wedding|gift|new-arrival|best-seller|trending|offers|brand|designs)/i.test(l))
      .slice(0, 6);

    // Add known product listing paths for this domain (if we have them)
    const knownPaths = KNOWN_PRODUCT_PATHS[hostname] || [];
    const allCandidatePaths = [...new Set([...linkDiscovered, ...knownPaths])].slice(0, 10);

    logger.info({ url, discoveredPaths: linkDiscovered.length, knownPaths: knownPaths.length, totalPaths: allCandidatePaths.length }, 'Product page paths identified');

    const allProducts: CrawlProduct[] = [];

    // Extract products from main page
    allProducts.push(...this.extractProducts($, baseUrl));

    // Crawl sub-pages for products
    const subPageResults = await this.crawlSubPages(allCandidatePaths, baseUrl);
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
      crawlDifficulty,
    };

    logger.info(
      { url, productsFound: uniqueProducts.length, pagesScraped: crawlResult.pageCount },
      'Site crawl completed',
    );

    return crawlResult;
  }

  /** Detect bot protection / challenge pages that didn't resolve */
  private isBlockedPage(html: string): boolean {
    return (
      html.includes('Just a moment...') ||
      html.includes('cf-browser-verification') ||
      html.includes('Checking your browser') ||
      html.includes('challenge-platform') ||
      // Extremely short HTML = probably a redirect/block page
      (html.length < 2000 && /<title>\s*(just a moment|attention required|access denied)/i.test(html))
    );
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
          [
            '.product-card', '.product-item', '.product',
            '[class*="ProductCard"]', '[class*="productCard"]', '[class*="product-card"]',
            '[class*="plp-product"]', '[class*="catalog-product"]',
            '[itemtype*="Product"]',
            // BlueStone specific
            '[class*="pid-"]', '.product-details',
            // Melorra specific
            '.card.product-card',
            // PNG / Shopify specific
            '.card-wrapper.product-card-wrapper', '.card__inner',
            // CaratLane specific
            '[class*="ProductCard"]', '[class*="product_card"]',
          ].join(', '),
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

      let html = await page.content();

      // Check if we got a Cloudflare challenge page
      if (this.isBlockedPage(html)) {
        logger.info({ url }, 'Cloudflare/bot challenge detected — waiting for resolution');
        await new Promise((resolve) => setTimeout(resolve, 8000));
        html = await page.content();

        // If still blocked, try one more wait
        if (this.isBlockedPage(html)) {
          logger.warn({ url }, 'Challenge still present — waiting longer');
          await new Promise((resolve) => setTimeout(resolve, 8000));
          html = await page.content();
        }

        // If STILL blocked after 16s of waiting, throw so we don't save garbage
        if (this.isBlockedPage(html)) {
          throw new Error(`Bot protection blocked crawl for ${url} — page never resolved`);
        }
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
          links.add(resolved.pathname + resolved.search);
        }
      } catch { /* skip malformed URLs */ }
    });
    return [...links];
  }

  private extractProducts($: cheerio.CheerioAPI, baseUrl: string): CrawlProduct[] {
    const products: CrawlProduct[] = [];

    // ────────────────────────────────────────────────────────────────
    // Strategy 1: JSON-LD structured data (most reliable — works for Melorra, some BlueStone pages)
    // ────────────────────────────────────────────────────────────────
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).text());

        // Direct Product type
        if (json['@type'] === 'Product' && json.name) {
          const offers = json.offers;
          const price = offers?.price || offers?.lowPrice
            || (Array.isArray(offers) ? offers[0]?.price : 0) || 0;
          products.push({
            name: json.name,
            price: parseFloat(String(price)) || 0,
            currency: offers?.priceCurrency || (Array.isArray(offers) ? offers[0]?.priceCurrency : 'INR') || 'INR',
            url: json.url || undefined,
          });
        }

        // ItemList (Melorra uses this with ListItem children)
        if (json['@type'] === 'ItemList' && Array.isArray(json.itemListElement)) {
          for (const listItem of json.itemListElement) {
            const item = listItem.item || listItem;
            if (item.name) {
              products.push({
                name: item.name,
                price: 0,
                currency: 'INR',
                url: item.url || undefined,
              });
            }
          }
        }

        // @graph container
        if (Array.isArray(json['@graph'])) {
          for (const item of json['@graph']) {
            if (item['@type'] === 'Product' && item.name) {
              const offers = item.offers;
              const price = offers?.price || offers?.lowPrice || 0;
              products.push({
                name: item.name,
                price: parseFloat(String(price)) || 0,
                currency: offers?.priceCurrency || 'INR',
                url: item.url || undefined,
              });
            }
          }
        }
      } catch { /* skip invalid JSON-LD */ }
    });

    if (products.length > 0) {
      logger.debug({ strategy: 'json-ld', count: products.length }, 'Products extracted via JSON-LD');
      return products;
    }

    // ────────────────────────────────────────────────────────────────
    // Strategy 2: Site-specific CSS selectors (verified against actual DOMs)
    // ────────────────────────────────────────────────────────────────

    // BlueStone: class="pid-XXXX ..." with .p-name and .new-price .WebRupee
    const bluestoneCards = $('[class^="pid-"]');
    if (bluestoneCards.length >= 2) {
      bluestoneCards.each((_, el) => {
        const $el = $(el);
        // Name is inside .p-name > a
        const name = $el.find('.p-name a').first().text().trim()
          || $el.find('.p-name').first().text().trim();
        // Price: look for text after WebRupee span
        const priceText = $el.find('.new-price').text().trim() || $el.find('.b-price-left').text().trim();
        const price = this.parseIndianPrice(priceText);
        const link = $el.find('.p-name a, a.pr-i, a').first().attr('href');

        if (name && name.length > 2) {
          products.push({
            name,
            price,
            currency: 'INR',
            url: link ? this.resolveUrl(link, baseUrl) : undefined,
          });
        }
      });
      if (products.length > 0) {
        logger.debug({ strategy: 'bluestone-pid', count: products.length }, 'Products extracted via BlueStone selectors');
        return products;
      }
    }

    // Melorra: class="card product-card pdt-outer" or jsx-* product_card
    const melorraCards = $('[class*="product-card"][class*="pdt-outer"], [class*="product_card"]');
    if (melorraCards.length >= 2) {
      melorraCards.each((_, el) => {
        const $el = $(el);
        const name = $el.find('[class*="customizedProductTitle"], [class*="ProductTitle"]').first().text().trim()
          || $el.find('h2, h3, .title').first().text().trim();
        const priceText = $el.find('[class*="price"], [class*="Price"]').first().text().trim();
        const price = this.parseIndianPrice(priceText);
        const link = $el.find('a').first().attr('href');

        if (name && name.length > 2) {
          products.push({
            name,
            price,
            currency: 'INR',
            url: link ? this.resolveUrl(link, baseUrl) : undefined,
          });
        }
      });
      if (products.length > 0) {
        logger.debug({ strategy: 'melorra-card', count: products.length }, 'Products extracted via Melorra selectors');
        return products;
      }
    }

    // PNG / Shopify: .card-wrapper.product-card-wrapper or .mega_col_product_list_item
    const pngCards = $('.card-wrapper.product-card-wrapper, .mega_col_product_list_item');
    if (pngCards.length >= 2) {
      pngCards.each((_, el) => {
        const $el = $(el);
        const name = $el.find('.card__heading a, .card__heading, h2, h3').first().text().trim()
          || $el.find('img[alt]').first().attr('alt')?.trim() || '';
        const priceText = $el.find('.price, .price-item, [class*="price"], .money').first().text().trim();
        const price = this.parseIndianPrice(priceText);
        const link = $el.find('a').first().attr('href');

        if (name && name.length > 2 && name.length < 200) {
          products.push({
            name,
            price,
            currency: 'INR',
            url: link ? this.resolveUrl(link, baseUrl) : undefined,
          });
        }
      });
      if (products.length > 0) {
        logger.debug({ strategy: 'shopify-card', count: products.length }, 'Products extracted via Shopify/PNG selectors');
        return products;
      }
    }

    // ────────────────────────────────────────────────────────────────
    // Strategy 3: Generic CSS selectors (broad catch-all)
    // ────────────────────────────────────────────────────────────────
    const genericSelectors = [
      // Most common e-commerce patterns
      '.product-card', '.product-item', '.product-tile', '.product-grid-item',
      '.wc-block-grid__product', '[data-product-id]', '.productCard',
      // Attribute-based (catches React/Next.js sites like CaratLane/Tanishq)
      '[class*="ProductCard"]', '[class*="productCard"]', '[class*="product-card"]',
      '[class*="ProductTile"]', '[class*="productTile"]', '[class*="product-tile"]',
      '[class*="ProductItem"]', '[class*="product-item"]',
      '[class*="plp-product"]', '[class*="plp_product"]',
      '[class*="PLPProduct"]', '[class*="search-product"]',
      '[class*="catalog-product"]',
      '[data-testid*="product"]', '[data-component*="product"]',
      // Card + product combo
      '[class*="card"][class*="product"]', '[class*="item"][class*="product"]',
      // Grid children (fallback for custom grids)
      '.product-grid > div', '.products-grid > div', '.product-list > div',
      '[class*="ProductGrid"] > div', '[class*="productGrid"] > div',
      '.product-grid > li', '.products > li',
    ];

    // Name selectors — broad
    const nameSelectors = [
      '.product-title', '.product-name', '.woocommerce-loop-product__title',
      'h2', 'h3', 'h4',
      '.title', '.name',
      '[class*="name"]', '[class*="title"]', '[class*="Name"]', '[class*="Title"]',
      '[class*="product-name"]', '[class*="productName"]',
      'a[title]',
    ].join(', ');

    // Price selectors
    const priceSelectors = [
      '.price', '.product-price', '.amount',
      '[class*="price"]', '[class*="Price"]',
      '[class*="cost"]', '[class*="Cost"]',
      '[class*="mrp"]', '[class*="MRP"]',
      '.money', '[class*="money"]',
    ].join(', ');

    for (const selector of genericSelectors) {
      const found: CrawlProduct[] = [];
      $(selector).each((_, el) => {
        const $el = $(el);
        let name = $el.find(nameSelectors).first().text().trim();
        if (!name) name = $el.find('a[title]').attr('title')?.trim() || '';
        if (!name) name = $el.find('img[alt]').attr('alt')?.trim() || '';

        const priceText = $el.find(priceSelectors).first().text().trim();
        const price = this.parseIndianPrice(priceText);
        const link = $el.find('a').first().attr('href') || $el.closest('a').attr('href');

        if (name && name.length > 2 && name.length < 300) {
          found.push({
            name,
            price,
            currency: 'INR',
            url: link ? this.resolveUrl(link, baseUrl) : undefined,
          });
        }
      });
      if (found.length >= 2) {
        products.push(...found);
        logger.debug({ strategy: 'generic-css', selector, count: found.length }, 'Products extracted via generic selector');
        break;
      }
    }

    if (products.length > 0) return products;

    // ────────────────────────────────────────────────────────────────
    // Strategy 4: Microdata (itemprop)
    // ────────────────────────────────────────────────────────────────
    $('[itemtype*="schema.org/Product"], [itemtype*="Product"]').each((_, el) => {
      const $el = $(el);
      const name = $el.find('[itemprop="name"]').first().text().trim();
      const priceText = $el.find('[itemprop="price"]').first().text().trim()
        || $el.find('[itemprop="price"]').attr('content') || '';
      const price = this.parseIndianPrice(priceText);
      const url = $el.find('[itemprop="url"]').attr('href') || $el.find('a').first().attr('href');

      if (name && name.length > 2) {
        products.push({
          name,
          price,
          currency: 'INR',
          url: url ? this.resolveUrl(url, baseUrl) : undefined,
        });
      }
    });

    if (products.length > 0) {
      logger.debug({ strategy: 'microdata', count: products.length }, 'Products extracted via microdata');
      return products;
    }

    // ────────────────────────────────────────────────────────────────
    // Strategy 5: Heuristic — find price-like patterns and walk up DOM
    // ────────────────────────────────────────────────────────────────
    const priceElements = $('*').filter((_, el) => {
      const text = $(el).text().trim();
      // Match ₹ followed by number, or Rs/Rs. followed by number
      return /^[₹][\s]*[\d,]+/.test(text) || /^Rs\.?\s*[\d,]+/.test(text);
    });

    if (priceElements.length >= 2) {
      priceElements.slice(0, 50).each((_, el) => {
        const $priceEl = $(el);
        // Walk up max 4 levels to find a "card" container
        let $card = $priceEl.parent();
        for (let i = 0; i < 4; i++) {
          // Check if this looks like a product container (has both name-like text and a link)
          const hasLink = $card.find('a').length > 0;
          const hasImage = $card.find('img').length > 0;
          if (hasLink && hasImage) break;
          $card = $card.parent();
        }

        // Extract name from the card
        let name = $card.find('h2, h3, h4, [class*="name"], [class*="title"], [class*="Name"], [class*="Title"]').first().text().trim();
        if (!name) name = $card.find('a[title]').attr('title')?.trim() || '';
        if (!name) name = $card.find('img[alt]').attr('alt')?.trim() || '';

        const price = this.parseIndianPrice($priceEl.text().trim());
        const link = $card.find('a').first().attr('href');

        if (name && name.length > 2 && name.length < 200 && price > 0) {
          products.push({
            name,
            price,
            currency: 'INR',
            url: link ? this.resolveUrl(link, baseUrl) : undefined,
          });
        }
      });

      if (products.length > 0) {
        logger.debug({ strategy: 'heuristic-price', count: products.length }, 'Products extracted via price heuristic');
      }
    }

    // ────────────────────────────────────────────────────────────────
    // Strategy 6: SPA state extraction (CaratLane __PRELOADED_STATE__, Next.js __NEXT_DATA__)
    // ────────────────────────────────────────────────────────────────
    if (products.length === 0) {
      $('script').each((_, el) => {
        const scriptText = $(el).text();

        // __NEXT_DATA__ (Next.js)
        if (scriptText.includes('__NEXT_DATA__')) {
          try {
            const match = scriptText.match(/__NEXT_DATA__\s*=\s*({.*})/);
            if (match) {
              const data = JSON.parse(match[1]);
              this.extractFromNestedObject(data, products, baseUrl);
            }
          } catch { /* skip */ }
        }

        // __PRELOADED_STATE__ (CaratLane-style Redux)
        if (scriptText.includes('__PRELOADED_STATE__')) {
          try {
            const match = scriptText.match(/__PRELOADED_STATE__\s*=\s*({.*})/);
            if (match) {
              const data = JSON.parse(match[1]);
              this.extractFromNestedObject(data, products, baseUrl);
            }
          } catch { /* skip */ }
        }
      });

      if (products.length > 0) {
        logger.debug({ strategy: 'spa-state', count: products.length }, 'Products extracted via SPA state');
      }
    }

    return products;
  }

  /** Recursively search a nested object for product-like data (name + price patterns) */
  private extractFromNestedObject(
    obj: unknown,
    products: CrawlProduct[],
    baseUrl: string,
    depth = 0,
  ): void {
    if (depth > 8 || products.length > 100) return;

    if (Array.isArray(obj)) {
      // If array of objects with 'name' and 'price' — likely products
      if (obj.length >= 2 && obj[0] && typeof obj[0] === 'object') {
        const first = obj[0] as Record<string, unknown>;
        if ('name' in first && ('price' in first || 'sellingPrice' in first || 'mrp' in first || 'offers' in first)) {
          for (const item of obj.slice(0, 50)) {
            const rec = item as Record<string, unknown>;
            const name = String(rec.name || rec.productName || rec.title || '');
            const price = Number(rec.price || rec.sellingPrice || rec.mrp || 0);
            const url = String(rec.url || rec.slug || rec.href || '');

            if (name && name.length > 2 && name.length < 200) {
              products.push({
                name,
                price: price || 0,
                currency: 'INR',
                url: url ? this.resolveUrl(url, baseUrl) : undefined,
              });
            }
          }
          return;
        }
      }
      for (const item of obj.slice(0, 20)) {
        this.extractFromNestedObject(item, products, baseUrl, depth + 1);
      }
    } else if (obj && typeof obj === 'object') {
      const rec = obj as Record<string, unknown>;
      // Check if this object itself looks like a product
      if (rec.products && Array.isArray(rec.products)) {
        this.extractFromNestedObject(rec.products, products, baseUrl, depth + 1);
        return;
      }
      if (rec.items && Array.isArray(rec.items)) {
        this.extractFromNestedObject(rec.items, products, baseUrl, depth + 1);
        return;
      }
      // Recurse into keys that might contain product data
      for (const key of Object.keys(rec)) {
        if (/product|item|listing|catalog|search|result/i.test(key)) {
          this.extractFromNestedObject(rec[key], products, baseUrl, depth + 1);
        }
      }
    }
  }

  /** Safely resolve a URL against a base */
  private resolveUrl(href: string, baseUrl: string): string | undefined {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return undefined;
    }
  }

  /** Parse Indian price format: ₹1,23,456.00 or Rs. 2,11,316 → number */
  private parseIndianPrice(text: string): number {
    if (!text) return 0;
    // Remove currency symbols (₹, Rs, Rs.), spaces, and commas
    const cleaned = text.replace(/₹|Rs\.?|INR/gi, '').replace(/[\s,]/g, '').replace(/[^0-9.]/g, '');
    return parseFloat(cleaned) || 0;
  }

  private deduplicateProducts(products: CrawlProduct[]): CrawlProduct[] {
    const seen = new Map<string, CrawlProduct>();
    for (const p of products) {
      if (!this.isValidProduct(p)) continue;
      const key = p.name.toLowerCase().trim();
      if (key && !seen.has(key)) {
        seen.set(key, p);
      }
    }
    return [...seen.values()];
  }

  /** Filter out garbage / non-product entries */
  private isValidProduct(p: CrawlProduct): boolean {
    const name = p.name.trim().toLowerCase();

    // Too short or too long
    if (name.length < 3 || name.length > 200) return false;

    // CTA / marketing text patterns (not real product names)
    const garbagePatterns = [
      /^hi[,!]?\s/i, /looking for/i, /something special/i,
      /^shop\s/i, /^buy\s/i, /^view\s/i, /^explore\s/i, /^discover\s/i,
      /^sign\s?(up|in)/i, /^log\s?in/i, /^subscribe/i, /^newsletter/i,
      /^just a moment/i, /^loading/i, /^please wait/i,
      /^add to (cart|bag|wishlist)/i, /^checkout/i,
      /^free (shipping|delivery)/i, /^limited (time|offer)/i,
      /^click here/i, /^learn more/i, /^read more/i,
      /^contact us/i, /^help/i, /^faq/i,
      /^home$/i, /^menu$/i, /^search$/i, /^close$/i,
    ];
    if (garbagePatterns.some((re) => re.test(name))) return false;

    // Price sanity check for Indian jewelry (₹100 to ₹50,00,000 = 5 million)
    // If price is set but wildly out of range, it's garbage
    if (p.price > 0 && (p.price < 100 || p.price > 50_000_000)) return false;

    return true;
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
        const fullUrl = path.startsWith('http') ? path : `${baseUrl}${path}`;
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

        logger.debug({ url: fullUrl, htmlLength: html.length }, 'Sub-page fetched');
        const $ = cheerio.load(html);
        const subProducts = this.extractProducts($, baseUrl);
        results.push({ url: fullUrl, products: subProducts });
        logger.info({ url: fullUrl, productsFound: subProducts.length }, 'Sub-page crawled');

        // Stop early if we already have plenty of products
        const totalProducts = results.reduce((sum, r) => sum + r.products.length, 0);
        if (totalProducts >= 50) {
          logger.info({ totalProducts }, 'Sufficient products found — stopping sub-page crawl');
          break;
        }

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
