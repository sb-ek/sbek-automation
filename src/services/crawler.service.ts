import * as cheerio from 'cheerio';
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

// ── User-Agent rotation to avoid blocking ───────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

// ── Service ─────────────────────────────────────────────────────────

class CrawlerService {

  /**
   * Crawl a competitor site and extract structured data.
   * Built-in scraper — no external microservice needed.
   */
  async analyzeSite(url: string, _previousCrawl?: Record<string, unknown>): Promise<CrawlResult> {
    logger.info({ url }, 'Starting built-in site crawl');

    const baseUrl = new URL(url).origin;
    const mainPageHtml = await this.fetchPage(url);
    const $ = cheerio.load(mainPageHtml);

    const title = $('title').text().trim();
    const meta = this.extractMeta($);
    const techSeo = this.extractTechSeo($);

    // Collect internal links for deeper crawl
    const internalLinks = this.extractInternalLinks($, baseUrl);

    // Find product/collection pages (max 5 sub-pages to stay within rate limits)
    const productPages = internalLinks
      .filter((l) => /\/(product|shop|collection|jewel|ring|necklace|earring|bracelet|pendant|category)/i.test(l))
      .slice(0, 5);

    const allProducts: CrawlProduct[] = [];

    // Extract products from main page
    allProducts.push(...this.extractProducts($, baseUrl));

    // Crawl sub-pages in parallel (3 concurrent)
    const subPageResults = await this.crawlSubPages(productPages, baseUrl);
    for (const result of subPageResults) {
      allProducts.push(...result.products);
    }

    // Deduplicate products by name
    const uniqueProducts = this.deduplicateProducts(allProducts);

    // Check sitemap and robots.txt
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
      'Built-in site crawl completed',
    );

    return crawlResult;
  }

  /** Health check — always healthy since this is built-in. */
  async getHealth(): Promise<{ status: string }> {
    return { status: 'ok' };
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
    ];

    for (const selector of selectors) {
      const found: CrawlProduct[] = [];
      $(selector).each((_, el) => {
        const $el = $(el);
        const name = $el.find('.product-title, .product-name, .woocommerce-loop-product__title, h2, h3').first().text().trim();
        const priceText = $el.find('.price, .product-price, .amount').first().text().trim();
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

    for (let i = 0; i < urls.length; i += 3) {
      const batch = urls.slice(i, i + 3);
      const batchResults = await Promise.allSettled(
        batch.map(async (path) => {
          const fullUrl = `${baseUrl}${path}`;
          const html = await this.fetchPage(fullUrl);
          const $ = cheerio.load(html);
          return { url: fullUrl, products: this.extractProducts($, baseUrl) };
        }),
      );

      for (const r of batchResults) {
        if (r.status === 'fulfilled') results.push(r.value);
      }
    }

    return results;
  }

  // ── HTTP helpers ─────────────────────────────────────────────────

  private async fetchPage(url: string): Promise<string> {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
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

  private async fetchText(url: string): Promise<string> {
    try {
      const html = await this.fetchPage(url);
      return html.slice(0, 2000);
    } catch {
      return '';
    }
  }

  private async checkUrl(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ── Singleton Export ────────────────────────────────────────────────────────

export const crawler = new CrawlerService();
