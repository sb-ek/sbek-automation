import WooCommerceRestApiPkg from '@woocommerce/woocommerce-rest-api';
const WooCommerceRestApi = (WooCommerceRestApiPkg as any).default || WooCommerceRestApiPkg;
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { settings } from './settings.service.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface WooOrder {
  id: number;
  status: string;
  currency: string;
  total: string;
  date_created: string;
  date_modified: string;
  payment_method: string;
  payment_method_title: string;
  customer_id: number;
  billing: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    address_1: string;
    address_2: string;
    city: string;
    state: string;
    postcode: string;
    country: string;
  };
  shipping: {
    first_name: string;
    last_name: string;
    address_1: string;
    address_2: string;
    city: string;
    state: string;
    postcode: string;
    country: string;
  };
  line_items: Array<{
    id: number;
    name: string;
    product_id: number;
    variation_id: number;
    quantity: number;
    total: string;
    sku: string;
    meta_data: Array<{ id: number; key: string; value: string }>;
    attributes?: Array<{ name: string; option: string }>;
  }>;
  customer_note: string;
  meta_data: Array<{ id: number; key: string; value: string }>;
}

export interface WooProduct {
  id: number;
  name: string;
  slug: string;
  type: string;
  status: string;
  description: string;
  short_description: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  stock_status: string;
  stock_quantity: number | null;
  categories: Array<{ id: number; name: string; slug: string }>;
  images: Array<{ id: number; src: string; name: string; alt: string }>;
  attributes: Array<{
    id: number;
    name: string;
    options: string[];
    visible: boolean;
    variation: boolean;
  }>;
  meta_data: Array<{ id: number; key: string; value: string }>;
}

export interface WooCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  username: string;
  billing: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    address_1: string;
    address_2: string;
    city: string;
    state: string;
    postcode: string;
    country: string;
  };
  shipping: {
    first_name: string;
    last_name: string;
    address_1: string;
    address_2: string;
    city: string;
    state: string;
    postcode: string;
    country: string;
  };
  avatar_url: string;
  date_created: string;
  orders_count: number;
  total_spent: string;
}

export interface JewelryMeta {
  ringSize?: string;
  metalType?: string;
  stoneType?: string;
  engravingText?: string;
  engravingFont?: string;
}

export interface ParsedOrderRow {
  orderId: number;
  customerName: string;
  phone: string;
  email: string;
  products: string;
  variantDetails: string;
  jewelryMeta: string;
  amount: string;
  orderDate: string;
  status: string;
  paymentMethod: string;
  notes: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

class WooCommerceService {
  private api: any;
  /** Hash of the credentials used to create the current API client */
  private credHash = '';

  constructor() {
    this.api = new WooCommerceRestApi({
      url: env.WOO_URL,
      consumerKey: env.WOO_CONSUMER_KEY,
      consumerSecret: env.WOO_CONSUMER_SECRET,
      version: 'wc/v3',
      queryStringAuth: true,
      timeout: 30_000,
    });
    this.credHash = this.hashCreds(env.WOO_URL, env.WOO_CONSUMER_KEY, env.WOO_CONSUMER_SECRET);
  }

  /**
   * Get the WooCommerce API client, re-creating it if credentials have
   * been updated via the Settings dashboard.
   */
  private async getApi(): Promise<any> {
    const url = (await settings.get('WOO_URL')) ?? env.WOO_URL;
    const key = (await settings.get('WOO_CONSUMER_KEY')) ?? env.WOO_CONSUMER_KEY;
    const secret = (await settings.get('WOO_CONSUMER_SECRET')) ?? env.WOO_CONSUMER_SECRET;
    const hash = this.hashCreds(url, key, secret);

    if (hash !== this.credHash) {
      this.api = new WooCommerceRestApi({
        url,
        consumerKey: key,
        consumerSecret: secret,
        version: 'wc/v3',
        queryStringAuth: true,
        timeout: 30_000,
      });
      this.credHash = hash;
      logger.info('WooCommerce API client re-created with updated credentials');
    }

    return this.api;
  }

  private hashCreds(...parts: (string | undefined)[]): string {
    return parts.map((p) => p ?? '').join('|');
  }

  // ── Order Methods ───────────────────────────────────────────────────────

  async getOrder(orderId: number): Promise<WooOrder> {
    try {
      const api = await this.getApi();
      const response = await api.get(`orders/${orderId}`);
      return response.data as WooOrder;
    } catch (error) {
      logger.error({ err: error, orderId }, 'Failed to fetch WooCommerce order');
      throw error;
    }
  }

  async listOrders(
    params?: { status?: string; per_page?: number; page?: number; after?: string },
  ): Promise<WooOrder[]> {
    try {
      const api = await this.getApi();
      const response = await api.get('orders', params ?? {});
      return response.data as WooOrder[];
    } catch (error) {
      logger.error({ err: error, params }, 'Failed to list WooCommerce orders');
      throw error;
    }
  }

  async updateOrder(
    orderId: number,
    data: Record<string, unknown>,
  ): Promise<WooOrder> {
    try {
      const api = await this.getApi();
      const response = await api.put(`orders/${orderId}`, data);
      return response.data as WooOrder;
    } catch (error) {
      logger.error({ err: error, orderId, data }, 'Failed to update WooCommerce order');
      throw error;
    }
  }

  async getOrderNotes(
    orderId: number,
  ): Promise<Array<{ id: number; note: string; customer_note: boolean; date_created: string }>> {
    try {
      const api = await this.getApi();
      const response = await api.get(`orders/${orderId}/notes`);
      return response.data;
    } catch (error) {
      logger.error({ err: error, orderId }, 'Failed to fetch WooCommerce order notes');
      throw error;
    }
  }

  async addOrderNote(
    orderId: number,
    note: string,
    customerNote: boolean = false,
  ): Promise<{ id: number; note: string; customer_note: boolean; date_created: string }> {
    try {
      const api = await this.getApi();
      const response = await api.post(`orders/${orderId}/notes`, {
        note,
        customer_note: customerNote,
      });
      return response.data;
    } catch (error) {
      logger.error({ err: error, orderId, note }, 'Failed to add WooCommerce order note');
      throw error;
    }
  }

  // ── Product Methods ─────────────────────────────────────────────────────

  async getProduct(productId: number): Promise<WooProduct> {
    try {
      const api = await this.getApi();
      const response = await api.get(`products/${productId}`);
      return response.data as WooProduct;
    } catch (error) {
      logger.error({ err: error, productId }, 'Failed to fetch WooCommerce product');
      throw error;
    }
  }

  async listProducts(
    params?: { category?: number; per_page?: number; page?: number; status?: string },
  ): Promise<WooProduct[]> {
    try {
      const api = await this.getApi();
      const response = await api.get('products', params ?? {});
      return response.data as WooProduct[];
    } catch (error) {
      logger.error({ err: error, params }, 'Failed to list WooCommerce products');
      throw error;
    }
  }

  async updateProduct(
    productId: number,
    data: Record<string, unknown>,
  ): Promise<WooProduct> {
    try {
      const api = await this.getApi();
      const response = await api.put(`products/${productId}`, data);
      return response.data as WooProduct;
    } catch (error) {
      logger.error({ err: error, productId, data }, 'Failed to update WooCommerce product');
      throw error;
    }
  }

  async getProductMedia(productId: number): Promise<string[]> {
    try {
      const product = await this.getProduct(productId);
      return (product.images ?? []).map((img) => img.src);
    } catch (error) {
      logger.error({ err: error, productId }, 'Failed to fetch WooCommerce product media');
      throw error;
    }
  }

  // ── Customer Methods ────────────────────────────────────────────────────

  async getCustomer(customerId: number): Promise<WooCustomer> {
    try {
      const api = await this.getApi();
      const response = await api.get(`customers/${customerId}`);
      return response.data as WooCustomer;
    } catch (error) {
      logger.error({ err: error, customerId }, 'Failed to fetch WooCommerce customer');
      throw error;
    }
  }

  async listCustomers(
    params?: { per_page?: number; page?: number },
  ): Promise<WooCustomer[]> {
    try {
      const api = await this.getApi();
      const response = await api.get('customers', params ?? {});
      return response.data as WooCustomer[];
    } catch (error) {
      logger.error({ err: error, params }, 'Failed to list WooCommerce customers');
      throw error;
    }
  }

  // ── Webhook Methods ─────────────────────────────────────────────────────

  async registerWebhook(
    topic: string,
    deliveryUrl: string,
    secret: string,
  ): Promise<{ id: number; topic: string; delivery_url: string; status: string }> {
    try {
      const api = await this.getApi();
      const response = await api.post('webhooks', {
        topic,
        delivery_url: deliveryUrl,
        secret,
      });
      return response.data;
    } catch (error) {
      logger.error(
        { err: error, topic, deliveryUrl },
        'Failed to register WooCommerce webhook',
      );
      throw error;
    }
  }

  async listWebhooks(): Promise<
    Array<{ id: number; topic: string; delivery_url: string; status: string }>
  > {
    try {
      const api = await this.getApi();
      const response = await api.get('webhooks');
      return response.data;
    } catch (error) {
      logger.error({ err: error }, 'Failed to list WooCommerce webhooks');
      throw error;
    }
  }

  // ── Auto-register Webhooks ──────────────────────────────────────────

  /**
   * Ensure that WooCommerce webhooks for order events are registered.
   * Lists existing webhooks, checks for missing topics, and creates them.
   * Returns { registered: string[], existing: string[] }.
   */
  async ensureWebhooks(
    baseUrl?: string,
  ): Promise<{ registered: string[]; existing: string[] }> {
    const registered: string[] = [];
    const existing: string[] = [];

    // Resolve public base URL
    const publicUrl =
      baseUrl?.replace(/\/+$/, '') ||
      env.PUBLIC_URL?.replace(/\/+$/, '') ||
      (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');

    if (!publicUrl) {
      logger.warn('Cannot register webhooks: no PUBLIC_URL, RAILWAY_PUBLIC_DOMAIN, or baseUrl provided');
      return { registered, existing };
    }

    const webhookSecret =
      (await settings.get('WOO_WEBHOOK_SECRET' as any)) ??
      env.WOO_WEBHOOK_SECRET ??
      'sbek-webhook-secret';

    // Topics to ensure, mapped to their delivery URLs
    const requiredWebhooks: Array<{ topic: string; name: string; deliveryUrl: string }> = [
      {
        topic: 'order.created',
        name: 'SBEK - Order Created',
        deliveryUrl: `${publicUrl}/api/webhooks/woocommerce/order`,
      },
      {
        topic: 'order.updated',
        name: 'SBEK - Order Updated',
        deliveryUrl: `${publicUrl}/api/webhooks/woocommerce/order`,
      },
      {
        topic: 'order.deleted',
        name: 'SBEK - Order Deleted',
        deliveryUrl: `${publicUrl}/api/webhooks/woocommerce/order`,
      },
    ];

    try {
      const api = await this.getApi();

      // List all existing webhooks (paginate to be safe)
      let allWebhooks: Array<{ id: number; topic: string; delivery_url: string; status: string }> = [];
      try {
        const response = await api.get('webhooks', { per_page: 100 });
        allWebhooks = response.data ?? [];
      } catch (err) {
        logger.error({ err }, 'Failed to list existing webhooks during ensureWebhooks');
        throw err;
      }

      for (const wh of requiredWebhooks) {
        const alreadyExists = allWebhooks.some(
          (existing) =>
            existing.topic === wh.topic &&
            existing.delivery_url === wh.deliveryUrl &&
            existing.status === 'active',
        );

        if (alreadyExists) {
          existing.push(wh.topic);
          logger.info({ topic: wh.topic }, 'Webhook already registered');
          continue;
        }

        try {
          const response = await api.post('webhooks', {
            name: wh.name,
            topic: wh.topic,
            delivery_url: wh.deliveryUrl,
            secret: webhookSecret,
            status: 'active',
          });
          registered.push(wh.topic);
          logger.info(
            { topic: wh.topic, id: response.data?.id, deliveryUrl: wh.deliveryUrl },
            'Webhook registered successfully',
          );
        } catch (err) {
          logger.error({ err, topic: wh.topic }, 'Failed to register webhook');
        }
      }

      logger.info(
        { registered, existing, baseUrl: publicUrl },
        'ensureWebhooks completed',
      );
    } catch (err) {
      logger.error({ err }, 'ensureWebhooks failed — WooCommerce API may not be configured');
    }

    return { registered, existing };
  }

  // ── WordPress REST API helper (wp/v2 — NOT wc/v3) ──────────────────

  /**
   * Make a request to the WordPress REST API (wp/v2).
   * Uses WordPress Application Passwords for authentication.
   * WooCommerce API keys do NOT work for wp/v2 endpoints — you must
   * generate an Application Password in WP Admin → Users → Your Profile.
   */
  private async wpRequest(
    method: 'GET' | 'POST' | 'PUT',
    endpoint: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    const url = (await settings.get('WOO_URL')) ?? env.WOO_URL;
    const wpUser = (await settings.get('WP_APP_USERNAME')) ?? env.WP_APP_USERNAME;
    const wpPass = (await settings.get('WP_APP_PASSWORD')) ?? env.WP_APP_PASSWORD;

    if (!wpUser || !wpPass) {
      throw new Error(
        'WordPress Application Password not configured. ' +
        'Go to WP Admin → Users → Your Profile → Application Passwords, ' +
        'generate one, then set WP_APP_USERNAME and WP_APP_PASSWORD in Settings.',
      );
    }

    const fullUrl = `${url}/wp-json/wp/v2/${endpoint}`;
    const authHeader = 'Basic ' + Buffer.from(`${wpUser}:${wpPass}`).toString('base64');

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      signal: AbortSignal.timeout(30_000),
    };
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(fullUrl, options);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`WordPress API ${response.status}: ${errorText}`);
    }
    return response.json();
  }

  // ── WordPress Pages (for AEO Knowledge Base) ──────────────────────────

  /**
   * Create or update a WordPress page (for AEO knowledge base content).
   * Uses WordPress REST API (wp/v2/pages), NOT WooCommerce API.
   */
  async upsertPage(
    slug: string,
    title: string,
    content: string,
    status: 'publish' | 'draft' = 'publish',
  ): Promise<{ id: number; slug: string; link: string }> {
    try {
      const searchRes = await this.wpRequest('GET', `pages?slug=${encodeURIComponent(slug)}&per_page=1`);
      const existing = Array.isArray(searchRes) ? searchRes[0] : null;

      if (existing) {
        const updated = await this.wpRequest('PUT', `pages/${existing.id}`, { title, content, status });
        logger.info({ pageId: existing.id, slug }, 'WordPress page updated');
        return { id: updated.id, slug: updated.slug, link: updated.link };
      }

      const created = await this.wpRequest('POST', 'pages', { title, content, slug, status });
      logger.info({ pageId: created.id, slug }, 'WordPress page created');
      return { id: created.id, slug: created.slug, link: created.link };
    } catch (error) {
      logger.error({ err: error, slug }, 'Failed to upsert WordPress page');
      throw error;
    }
  }

  // ── WordPress Posts (for comparison articles) ────────────────────────

  /**
   * Create a WordPress blog post (for comparison articles).
   * Uses WordPress REST API (wp/v2/posts), NOT WooCommerce API.
   */
  async createPost(
    title: string,
    content: string,
    status: 'publish' | 'draft' = 'publish',
    categories?: number[],
  ): Promise<{ id: number; slug: string; link: string }> {
    try {
      const data: Record<string, unknown> = { title, content, status };
      if (categories?.length) data.categories = categories;

      const response = await this.wpRequest('POST', 'posts', data);
      logger.info({ postId: response.id }, 'WordPress post created');
      return { id: response.id, slug: response.slug, link: response.link };
    } catch (error) {
      logger.error({ err: error, title }, 'Failed to create WordPress post');
      throw error;
    }
  }

  // ── Related Products (for internal linking) ──────────────────────────

  /**
   * Get products in the same category for internal linking.
   */
  async getRelatedProducts(
    productId: number,
    limit: number = 5,
  ): Promise<Array<{ id: number; name: string; slug: string; link: string }>> {
    try {
      const product = await this.getProduct(productId);
      const categoryId = product.categories?.[0]?.id;
      if (!categoryId) return [];

      const api = await this.getApi();
      const wooUrl = (await settings.get('WOO_URL')) ?? env.WOO_URL;
      const response = await api.get('products', {
        category: categoryId,
        per_page: limit + 1,
        status: 'publish',
      });

      return (response.data as WooProduct[])
        .filter((p) => p.id !== productId)
        .slice(0, limit)
        .map((p) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          link: `${wooUrl}/product/${p.slug}/`,
        }));
    } catch (error) {
      logger.error({ err: error, productId }, 'Failed to fetch related products');
      return [];
    }
  }

  // ── Sitemap Ping ─────────────────────────────────────────────────────

  /**
   * Ping Google and Bing to re-crawl the sitemap after product changes.
   */
  async pingSitemap(): Promise<void> {
    const siteUrl = (await settings.get('WOO_URL')) ?? env.WOO_URL ?? env.BRAND_WEBSITE;
    if (!siteUrl) return;

    const sitemapUrl = `${siteUrl}/sitemap_index.xml`;
    const pingUrls = [
      `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
      `https://www.bing.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
    ];

    for (const url of pingUrls) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(10_000) });
        logger.info({ url }, 'Sitemap ping sent');
      } catch (err) {
        logger.warn({ err, url }, 'Sitemap ping failed');
      }
    }
  }

  // ── Helper Methods ──────────────────────────────────────────────────────

  /* eslint-disable @typescript-eslint/no-explicit-any */

  /**
   * Extract custom jewelry fields from a WooCommerce line item's meta_data
   * array and variation attributes. Looks for both underscore-prefixed custom
   * field keys (_ring_size, _metal_type, etc.) and WooCommerce product
   * attribute keys (pa_ring-size, pa_metal-type, pa_stone-type).
   */
  extractJewelryMeta(lineItem: any): JewelryMeta {
    const meta: JewelryMeta = {};

    // Key mappings: WooCommerce meta key -> JewelryMeta property
    const metaKeyMap: Record<string, keyof JewelryMeta> = {
      '_ring_size': 'ringSize',
      '_metal_type': 'metalType',
      '_stone_type': 'stoneType',
      '_engraving_text': 'engravingText',
      '_engraving_font': 'engravingFont',
      'pa_ring-size': 'ringSize',
      'pa_metal-type': 'metalType',
      'pa_stone-type': 'stoneType',
    };

    // Search through meta_data array
    const metaData: Array<{ key: string; value: string }> = lineItem?.meta_data ?? [];
    for (const entry of metaData) {
      const prop = metaKeyMap[entry.key];
      if (prop && entry.value) {
        meta[prop] = String(entry.value);
      }
    }

    // Also check variation attributes array (used on variable products)
    const attributes: Array<{ name: string; option: string }> =
      lineItem?.attributes ?? [];
    for (const attr of attributes) {
      // Normalise the attribute name for matching: lower-case, replace spaces
      // with hyphens, and prefix with pa_ to match the key map
      const normalised = `pa_${attr.name.toLowerCase().replace(/\s+/g, '-')}`;
      const prop = metaKeyMap[normalised];
      if (prop && attr.option) {
        // Only fill if not already populated from meta_data (meta_data takes
        // precedence as it may contain more specific custom-field values)
        meta[prop] ??= attr.option;
      }
    }

    return meta;
  }

  /**
   * Parse a full WooCommerce order into a flat object suitable for inserting
   * into a Google Sheets row.
   */
  parseOrderForSheets(order: any): ParsedOrderRow {
    const billing = order.billing ?? {};
    const shipping = order.shipping ?? {};
    const customerName =
      [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim() ||
      [shipping.first_name, shipping.last_name].filter(Boolean).join(' ').trim() ||
      (order.customer_note ? 'Customer' : 'Valued Customer');

    const lineItems: any[] = order.line_items ?? [];

    const products = lineItems.map((li: any) => li.name).join(' | ');

    const variantDetails = lineItems
      .map((li: any) => {
        const attrs: Array<{ name: string; option: string }> =
          li.attributes ?? [];
        if (attrs.length === 0) return '';
        return attrs.map((a) => `${a.name}: ${a.option}`).join(', ');
      })
      .filter(Boolean)
      .join(' | ');

    const jewelryMeta = lineItems
      .map((li: any) => {
        const jm = this.extractJewelryMeta(li);
        const parts: string[] = [];
        if (jm.ringSize) parts.push(`Ring: ${jm.ringSize}`);
        if (jm.metalType) parts.push(`Metal: ${jm.metalType}`);
        if (jm.stoneType) parts.push(`Stone: ${jm.stoneType}`);
        if (jm.engravingText) parts.push(`Engraving: ${jm.engravingText}`);
        if (jm.engravingFont) parts.push(`Font: ${jm.engravingFont}`);
        return parts.join(', ');
      })
      .filter(Boolean)
      .join(' | ');

    const notes = order.customer_note ?? '';

    return {
      orderId: order.id,
      customerName,
      phone: billing.phone ?? '',
      email: billing.email ?? '',
      products,
      variantDetails,
      jewelryMeta,
      amount: order.total ?? '0',
      orderDate: order.date_created ?? '',
      status: order.status ?? '',
      paymentMethod: order.payment_method_title ?? order.payment_method ?? '',
      notes,
    };
  }

  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ── Singleton Export ────────────────────────────────────────────────────────

export const woocommerce = new WooCommerceService();
