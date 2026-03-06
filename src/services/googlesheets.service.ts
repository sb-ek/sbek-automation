/**
 * Google Sheets service for the SBEK automation project.
 *
 * Manages five core tabs (Orders, Production, QC, Customers, Creatives) plus
 * a System Logs tab for operational visibility. All writes are sanitized to
 * prevent spreadsheet formula injection.
 */

import { GoogleSpreadsheet, GoogleSpreadsheetWorksheet } from 'google-spreadsheet';
import { JWT, OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sanitizeForSheets, sanitizeRow } from '../utils/sanitize.js';
import { settings } from './settings.service.js';

// ── Tab name constants ──────────────────────────────────────────────────────

const TAB_NAMES = {
  ORDERS: 'Orders',
  PRODUCTION: 'Production',
  QC: 'QC',
  CUSTOMERS: 'Customers',
  CREATIVES: 'Creatives',
  COMPETITORS: 'Competitors',
  SYSTEM_LOGS: 'System Logs',
} as const;

// ── Column headers per tab ──────────────────────────────────────────────────

const TAB_HEADERS: Record<string, string[]> = {
  [TAB_NAMES.ORDERS]: [
    'Order ID',
    'Customer Name',
    'Phone',
    'Email',
    'Product',
    'Variant',
    'Size',
    'Metal',
    'Stones',
    'Engraving',
    'Amount',
    'Order Date',
    'Promised Delivery',
    'Status',
    'Production Assignee',
    'Notes',
    'Last Updated',
  ],
  [TAB_NAMES.PRODUCTION]: [
    'Order ID',
    'Product',
    'Customer',
    'Ring Size',
    'Metal Type',
    'Stones',
    'Engraving Text',
    'Reference Image URL',
    'Assigned To',
    'Due Date',
    'Started Date',
    'Completed Date',
    'Status',
    'Notes',
  ],
  [TAB_NAMES.QC]: [
    'Order ID',
    'Product',
    'QC Date',
    'Checklist Item',
    'Pass/Fail',
    'Photo URL',
    'Inspector',
    'Notes',
    'Action Taken',
  ],
  [TAB_NAMES.CUSTOMERS]: [
    'Customer ID',
    'Name',
    'Email',
    'Phone',
    'Total Orders',
    'Total Spend',
    'Last Order Date',
    'Tags',
    'Notes',
  ],
  [TAB_NAMES.CREATIVES]: [
    'Product ID',
    'Product Name',
    'Variant',
    'Creative Type',
    'Image URL',
    'Drive Link',
    'Generated Date',
    'Status',
    'Approved By',
    'Posted Date',
  ],
  [TAB_NAMES.COMPETITORS]: [
    'Name',
    'URL',
    'Active',
    'Last Crawled',
    'Products Found',
    'Price Range',
    'SEO Score',
    'AI Analysis',
    'Changes Detected',
  ],
  [TAB_NAMES.SYSTEM_LOGS]: [
    'Timestamp',
    'Level',
    'Source',
    'Message',
    'Details',
  ],
};

// ── Service class ───────────────────────────────────────────────────────────

class GoogleSheetsService {
  private doc: GoogleSpreadsheet | null = null;
  private sheetCache: Map<string, GoogleSpreadsheetWorksheet> = new Map();
  private initialized = false;
  /** Hash of the credentials used for the current connection */
  private credHash = '';

  // ── Initialization ──────────────────────────────────────────────────────

  /**
   * Authenticate with Google via OAuth2 (preferred) or service-account JWT
   * (fallback), load the spreadsheet, and cache references to every expected
   * tab. If a tab does not exist it is created with the correct header row.
   *
   * Re-initializes automatically if credentials are updated via Settings.
   */
  async init(): Promise<void> {
    const sheetId = (await settings.get('GOOGLE_SHEET_ID')) ?? env.GOOGLE_SHEET_ID;
    const serviceEmail = (await settings.get('GOOGLE_SERVICE_ACCOUNT_EMAIL')) ?? env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = (await settings.get('GOOGLE_PRIVATE_KEY')) ?? env.GOOGLE_PRIVATE_KEY;

    let auth: JWT | OAuth2Client;
    let hash: string;

    if (serviceEmail && privateKey) {
      // Service account JWT — preferred for Sheets (has explicit spreadsheets scope)
      hash = [serviceEmail, sheetId ?? ''].join('|');

      if (this.initialized && hash === this.credHash) return;

      auth = new JWT({
        email: serviceEmail,
        key: privateKey.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      logger.info('Google Sheets: using service account JWT authentication');
    } else {
      // OAuth2 fallback — only works if token has spreadsheets scope (dashboard OAuth flow)
      const refreshToken = (await settings.get('GOOGLE_OAUTH_REFRESH_TOKEN')) ?? env.GOOGLE_OAUTH_REFRESH_TOKEN;
      const clientId = (await settings.get('GOOGLE_OAUTH_CLIENT_ID')) ?? env.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = (await settings.get('GOOGLE_OAUTH_CLIENT_SECRET')) ?? env.GOOGLE_OAUTH_CLIENT_SECRET;

      if (!refreshToken) {
        throw new Error('No Google credentials configured — set service account or connect via OAuth');
      }

      hash = ['oauth', clientId ?? '', sheetId ?? ''].join('|');

      if (this.initialized && hash === this.credHash) return;

      const oauth2 = new OAuth2Client(clientId, clientSecret);
      oauth2.setCredentials({ refresh_token: refreshToken });
      auth = oauth2;
      logger.info('Google Sheets: using OAuth2 authentication');
    }

    try {
      this.doc = new GoogleSpreadsheet(sheetId ?? '', auth);
      await this.doc.loadInfo();
      this.credHash = hash;

      logger.info(
        { title: this.doc.title, sheetId: env.GOOGLE_SHEET_ID },
        'Google Sheets spreadsheet loaded',
      );

      // Ensure every expected tab exists and cache its reference.
      for (const [_key, tabName] of Object.entries(TAB_NAMES)) {
        await this.ensureTab(tabName);
      }

      this.initialized = true;
      logger.info('Google Sheets service initialised — all tabs cached');

      // Apply formatting (color coding, dropdowns) — fire-and-forget
      this.applyFormatting().catch((err) =>
        logger.warn({ err }, 'Non-critical: failed to apply sheets formatting'),
      );
    } catch (error) {
      logger.error(
        { err: error },
        'Failed to initialise Google Sheets service',
      );
      throw error;
    }
  }

  /**
   * Ensure a tab with the given name exists. If it does not, create it and
   * set the header row from TAB_HEADERS.
   */
  private async ensureTab(tabName: string): Promise<void> {
    if (!this.doc) return;

    let sheet = this.doc.sheetsByTitle[tabName];

    const headers = TAB_HEADERS[tabName];

    if (!sheet) {
      if (!headers) {
        logger.warn({ tabName }, 'No header definition for tab — skipping creation');
        return;
      }

      logger.info({ tabName }, 'Tab not found — creating');
      sheet = await this.doc.addSheet({
        title: tabName,
        headerValues: headers,
      });
    } else if (headers) {
      // Tab exists — make sure the header row is present and correct
      await sheet.loadHeaderRow().catch(() => null);
      if (!sheet.headerValues || sheet.headerValues.length === 0) {
        logger.info({ tabName }, 'Tab exists but has no headers — setting header row');
        await sheet.setHeaderRow(headers);
      } else if (sheet.headerValues[0] !== headers[0] || sheet.headerValues.length < headers.length) {
        // Headers are mismatched (old schema) — update them
        logger.info({ tabName, old: sheet.headerValues[0], expected: headers[0] }, 'Tab headers mismatch — updating');
        await sheet.setHeaderRow(headers);
      }
    }

    this.sheetCache.set(tabName, sheet);
  }

  // ── Generic helpers ─────────────────────────────────────────────────────

  /**
   * Return the cached GoogleSpreadsheetWorksheet for a tab, or null if it has
   * not been loaded.
   */
  getSheet(tabName: string): GoogleSpreadsheetWorksheet | null {
    const sheet = this.sheetCache.get(tabName) ?? null;
    if (!sheet) {
      logger.warn({ tabName }, 'Sheet not found in cache');
    }
    return sheet;
  }

  /**
   * Guard that ensures the service has been initialised. Every public method
   * should call this before proceeding.
   */
  private assertInitialized(): void {
    if (!this.initialized || !this.doc) {
      throw new Error('GoogleSheetsService has not been initialised — call init() first');
    }
  }

  // ── Orders tab ──────────────────────────────────────────────────────────

  /**
   * Search the Orders sheet for a row whose "Order ID" matches, returning
   * the 0-based row index or null.
   */
  async findOrderRow(orderId: string): Promise<number | null> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.ORDERS);
      if (!sheet) return null;

      const rows = await sheet.getRows();
      const idx = rows.findIndex(
        (r) => r.get('Order ID') === sanitizeForSheets(orderId),
      );

      return idx === -1 ? null : idx;
    } catch (error) {
      logger.error({ err: error, orderId }, 'Error finding order row');
      return null;
    }
  }

  /** Append a new row to the Orders tab (with dedup — skips if Order ID exists). */
  async appendOrder(data: Record<string, string>): Promise<void> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.ORDERS);
      if (!sheet) return;

      // Dedup: check if this Order ID already exists
      const orderId = data['Order ID'];
      if (orderId) {
        const rows = await sheet.getRows();
        const exists = rows.some((r) => r.get('Order ID') === sanitizeForSheets(orderId));
        if (exists) {
          logger.info({ orderId }, 'Order already exists in sheet — skipping append');
          return;
        }
      }

      const sanitized = sanitizeRow(data);
      await sheet.addRow(sanitized);
      logger.info({ orderId: data['Order ID'] }, 'Order appended to sheet');
    } catch (error) {
      logger.error({ err: error, data }, 'Error appending order');
    }
  }

  /** Find an existing order by ID and merge the updates into it. */
  async updateOrder(orderId: string, updates: Record<string, string>): Promise<void> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.ORDERS);
      if (!sheet) return;

      const rows = await sheet.getRows();
      const row = rows.find((r) => r.get('Order ID') === sanitizeForSheets(orderId));

      if (!row) {
        logger.warn({ orderId }, 'Order not found for update');
        return;
      }

      const sanitized = sanitizeRow(updates);
      for (const [key, value] of Object.entries(sanitized)) {
        row.set(key, value);
      }
      await row.save();
      logger.info({ orderId }, 'Order updated in sheet');
    } catch (error) {
      logger.error({ err: error, orderId, updates }, 'Error updating order');
    }
  }

  /** Return every order row whose Status column matches. */
  async getOrdersByStatus(status: string): Promise<Record<string, string>[]> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.ORDERS);
      if (!sheet) return [];

      const rows = await sheet.getRows();
      const headers = TAB_HEADERS[TAB_NAMES.ORDERS];

      return rows
        .filter((r) => r.get('Status') === sanitizeForSheets(status))
        .map((r) => {
          const record: Record<string, string> = {};
          for (const h of headers) {
            record[h] = r.get(h) ?? '';
          }
          return record;
        });
    } catch (error) {
      logger.error({ err: error, status }, 'Error fetching orders by status');
      return [];
    }
  }

  /** Return every order row from the Orders tab (no status filtering). */
  async getAllOrders(): Promise<Record<string, string>[]> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.ORDERS);
      if (!sheet) return [];

      const rows = await sheet.getRows();
      const headers = TAB_HEADERS[TAB_NAMES.ORDERS];

      return rows.map((r) => {
        const record: Record<string, string> = {};
        for (const h of headers) {
          record[h] = r.get(h) ?? '';
        }
        return record;
      });
    } catch (error) {
      logger.error({ err: error }, 'Error fetching all orders');
      return [];
    }
  }

  // ── Production tab ──────────────────────────────────────────────────────

  /** Add a new row to the Production tab (with dedup — skips if Order ID exists). */
  async appendProductionTask(data: Record<string, string>): Promise<void> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.PRODUCTION);
      if (!sheet) return;

      // Dedup: check if a production task for this Order ID already exists
      const orderId = data['Order ID'];
      if (orderId) {
        const rows = await sheet.getRows();
        const exists = rows.some((r) => r.get('Order ID') === sanitizeForSheets(orderId));
        if (exists) {
          logger.info({ orderId }, 'Production task already exists — skipping append');
          return;
        }
      }

      const sanitized = sanitizeRow(data);
      await sheet.addRow(sanitized);
      logger.info({ orderId: data['Order ID'] }, 'Production task appended');
    } catch (error) {
      logger.error({ err: error, data }, 'Error appending production task');
    }
  }

  /** Update a production row's status (and optionally other fields). */
  async updateProductionStatus(
    orderId: string,
    status: string,
    extraData?: Record<string, string>,
  ): Promise<void> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.PRODUCTION);
      if (!sheet) return;

      const rows = await sheet.getRows();
      const row = rows.find((r) => r.get('Order ID') === sanitizeForSheets(orderId));

      if (!row) {
        logger.warn({ orderId }, 'Production row not found for status update');
        return;
      }

      row.set('Status', sanitizeForSheets(status));

      if (extraData) {
        const sanitized = sanitizeRow(extraData);
        for (const [key, value] of Object.entries(sanitized)) {
          row.set(key, value);
        }
      }

      await row.save();
      logger.info({ orderId, status }, 'Production status updated');
    } catch (error) {
      logger.error({ err: error, orderId, status }, 'Error updating production status');
    }
  }

  /** List all production rows whose Status matches. */
  async getProductionByStatus(status: string): Promise<Record<string, string>[]> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.PRODUCTION);
      if (!sheet) return [];

      const rows = await sheet.getRows();
      const headers = TAB_HEADERS[TAB_NAMES.PRODUCTION];

      return rows
        .filter((r) => r.get('Status') === sanitizeForSheets(status))
        .map((r) => {
          const record: Record<string, string> = {};
          for (const h of headers) {
            record[h] = r.get(h) ?? '';
          }
          return record;
        });
    } catch (error) {
      logger.error({ err: error, status }, 'Error fetching production by status');
      return [];
    }
  }

  // ── QC tab ──────────────────────────────────────────────────────────────

  /** Bulk-append QC checklist rows. */
  async appendQCItems(items: Array<Record<string, string>>): Promise<void> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.QC);
      if (!sheet) return;

      const sanitizedItems = items.map((item) => sanitizeRow(item));
      for (const row of sanitizedItems) {
        await sheet.addRow(row);
      }
      logger.info({ count: items.length }, 'QC items appended');
    } catch (error) {
      logger.error({ err: error, count: items.length }, 'Error appending QC items');
    }
  }

  /** Get every QC row for a given order. */
  async getQCItems(orderId: string): Promise<Record<string, string>[]> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.QC);
      if (!sheet) return [];

      const rows = await sheet.getRows();
      const headers = TAB_HEADERS[TAB_NAMES.QC];

      return rows
        .filter((r) => r.get('Order ID') === sanitizeForSheets(orderId))
        .map((r) => {
          const record: Record<string, string> = {};
          for (const h of headers) {
            record[h] = r.get(h) ?? '';
          }
          return record;
        });
    } catch (error) {
      logger.error({ err: error, orderId }, 'Error fetching QC items');
      return [];
    }
  }

  /** Update a specific QC checklist item for an order. */
  async updateQCItem(
    orderId: string,
    checklistItem: string,
    passFail: 'Pass' | 'Fail',
    notes?: string,
  ): Promise<void> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.QC);
      if (!sheet) return;

      const rows = await sheet.getRows();
      const row = rows.find(
        (r) =>
          r.get('Order ID') === sanitizeForSheets(orderId) &&
          r.get('Checklist Item') === sanitizeForSheets(checklistItem),
      );

      if (!row) {
        logger.warn({ orderId, checklistItem }, 'QC item not found for update');
        return;
      }

      row.set('Pass/Fail', sanitizeForSheets(passFail));
      if (notes !== undefined) {
        row.set('Notes', sanitizeForSheets(notes));
      }
      await row.save();
      logger.info({ orderId, checklistItem, passFail }, 'QC item updated');
    } catch (error) {
      logger.error({ err: error, orderId, checklistItem }, 'Error updating QC item');
    }
  }

  // ── Customers tab ───────────────────────────────────────────────────────

  /** Find a customer row by email, returning the row data or null. */
  async findCustomer(email: string): Promise<Record<string, string> | null> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.CUSTOMERS);
      if (!sheet) return null;

      const rows = await sheet.getRows();
      const headers = TAB_HEADERS[TAB_NAMES.CUSTOMERS];
      const row = rows.find(
        (r) => r.get('Email') === sanitizeForSheets(email),
      );

      if (!row) return null;

      const record: Record<string, string> = {};
      for (const h of headers) {
        record[h] = row.get(h) ?? '';
      }
      return record;
    } catch (error) {
      logger.error({ err: error, email }, 'Error finding customer');
      return null;
    }
  }

  /** Insert a new customer row or update an existing one (keyed on Email). */
  async upsertCustomer(data: Record<string, string>): Promise<void> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.CUSTOMERS);
      if (!sheet) return;

      const sanitized = sanitizeRow(data);
      const email = sanitized['Email'];

      if (!email) {
        logger.warn({ data }, 'Cannot upsert customer without Email');
        return;
      }

      const rows = await sheet.getRows();
      const existing = rows.find((r) => r.get('Email') === email);

      if (existing) {
        for (const [key, value] of Object.entries(sanitized)) {
          existing.set(key, value);
        }
        await existing.save();
        logger.info({ email }, 'Customer updated');
      } else {
        await sheet.addRow(sanitized);
        logger.info({ email }, 'Customer created');
      }
    } catch (error) {
      logger.error({ err: error, data }, 'Error upserting customer');
    }
  }

  // ── Creatives tab ───────────────────────────────────────────────────────

  /** Add a new creative row (with dedup — skips if Product ID + Variant exists). */
  async appendCreative(data: Record<string, string>): Promise<void> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.CREATIVES);
      if (!sheet) return;

      // Dedup: check if this Product ID + Variant combo already exists
      const productId = data['Product ID'];
      const variant = data['Variant'];
      if (productId && variant) {
        const rows = await sheet.getRows();
        const exists = rows.some(
          (r) =>
            r.get('Product ID') === sanitizeForSheets(productId) &&
            r.get('Variant') === sanitizeForSheets(variant),
        );
        if (exists) {
          logger.info({ productId, variant }, 'Creative already exists — skipping append');
          return;
        }
      }

      const sanitized = sanitizeRow(data);
      await sheet.addRow(sanitized);
      logger.info({ productId: data['Product ID'] }, 'Creative appended');
    } catch (error) {
      logger.error({ err: error, data }, 'Error appending creative');
    }
  }

  /** List all creative rows whose Status matches. */
  async getCreativesByStatus(status: string): Promise<Record<string, string>[]> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.CREATIVES);
      if (!sheet) return [];

      const rows = await sheet.getRows();
      const headers = TAB_HEADERS[TAB_NAMES.CREATIVES];

      return rows
        .filter((r) => r.get('Status') === sanitizeForSheets(status))
        .map((r) => {
          const record: Record<string, string> = {};
          for (const h of headers) {
            record[h] = r.get(h) ?? '';
          }
          return record;
        });
    } catch (error) {
      logger.error({ err: error, status }, 'Error fetching creatives by status');
      return [];
    }
  }

  /** Update the status of a creative row identified by Product ID + Variant. */
  async updateCreativeStatus(
    productId: string,
    variant: string,
    status: string,
  ): Promise<void> {
    this.assertInitialized();
    try {
      const sheet = this.getSheet(TAB_NAMES.CREATIVES);
      if (!sheet) return;

      const rows = await sheet.getRows();
      const row = rows.find(
        (r) =>
          r.get('Product ID') === sanitizeForSheets(productId) &&
          r.get('Variant') === sanitizeForSheets(variant),
      );

      if (!row) {
        logger.warn({ productId, variant }, 'Creative not found for status update');
        return;
      }

      row.set('Status', sanitizeForSheets(status));
      await row.save();
      logger.info({ productId, variant, status }, 'Creative status updated');
    } catch (error) {
      logger.error(
        { err: error, productId, variant, status },
        'Error updating creative status',
      );
    }
  }

  // ── Competitors tab ────────────────────────────────────────────────────

  /** Return all active competitors from the Competitors sheet tab. */
  async getCompetitors(): Promise<Array<{ name: string; url: string }>> {
    this.assertInitialized();
    try {
      if (!this.doc) return [];

      // Reload sheet metadata to pick up any external changes
      await this.doc.loadInfo();

      // Find sheet — exact match first, then case-insensitive fallback
      let sheet = this.doc.sheetsByTitle[TAB_NAMES.COMPETITORS];
      if (!sheet) {
        const allTitles = this.doc.sheetsByIndex.map((s) => s.title);
        logger.warn({ allTitles, expected: TAB_NAMES.COMPETITORS }, 'Competitors tab not found — checking case-insensitive');
        const match = this.doc.sheetsByIndex.find(
          (s) => s.title.toLowerCase().trim() === TAB_NAMES.COMPETITORS.toLowerCase(),
        );
        if (match) {
          sheet = match;
        } else {
          return [];
        }
      }

      // Load headers explicitly
      await sheet.loadHeaderRow();
      logger.info(
        { headers: sheet.headerValues, tabTitle: sheet.title },
        'Competitors tab headers loaded',
      );

      const rows = await sheet.getRows();
      logger.info({ rowCount: rows.length }, 'Competitors rows fetched');

      // Log first row raw data for debugging
      if (rows.length > 0) {
        const firstRow = rows[0];
        logger.info(
          { name: firstRow.get('Name'), url: firstRow.get('URL'), active: firstRow.get('Active'), rawValues: firstRow.toObject() },
          'First competitor row raw data',
        );
      }

      const result = rows
        .filter((r) => {
          const active = r.get('Active');
          return active !== 'No' && active !== 'FALSE' && active !== 'false';
        })
        .map((r) => ({
          name: (r.get('Name') ?? '').trim(),
          url: (r.get('URL') ?? '').trim(),
        }))
        .filter((c) => c.name && c.url);

      logger.info({ competitorsFound: result.length }, 'Active competitors resolved');
      return result;
    } catch (error) {
      logger.error({ err: error }, 'Error fetching competitors');
      return [];
    }
  }

  /** Add a new competitor row (with dedup — skips if Name already exists). */
  async appendCompetitor(data: Record<string, string>): Promise<void> {
    this.assertInitialized();
    try {
      await this.ensureTab(TAB_NAMES.COMPETITORS);
      const sheet = this.getSheet(TAB_NAMES.COMPETITORS);
      if (!sheet) return;

      // Dedup: check if competitor with this name already exists
      const name = data['Name'];
      if (name) {
        const rows = await sheet.getRows();
        const exists = rows.some((r) => r.get('Name') === sanitizeForSheets(name));
        if (exists) {
          logger.info({ name }, 'Competitor already exists — skipping append');
          return;
        }
      }

      const sanitized = sanitizeRow(data);
      await sheet.addRow(sanitized);
      logger.info({ name: data['Name'] }, 'Competitor appended');
    } catch (error) {
      logger.error({ err: error, data }, 'Error appending competitor');
    }
  }

  /** Update a competitor row with crawl results. */
  async updateCompetitor(name: string, data: Record<string, string>): Promise<void> {
    this.assertInitialized();
    try {
      await this.ensureTab(TAB_NAMES.COMPETITORS);
      const sheet = this.getSheet(TAB_NAMES.COMPETITORS);
      if (!sheet) return;

      const rows = await sheet.getRows();
      const row = rows.find((r) => r.get('Name') === name);
      if (!row) {
        logger.warn({ name }, 'Competitor not found for update');
        return;
      }

      for (const [key, value] of Object.entries(data)) {
        row.set(key, sanitizeForSheets(value));
      }
      await row.save();
      logger.info({ name }, 'Competitor row updated with crawl results');
    } catch (error) {
      logger.error({ err: error, name }, 'Error updating competitor');
    }
  }

  // ── Formatting & Data Validation ─────────────────────────────────────────

  /**
   * Apply conditional formatting (color-coded rows by status) and data
   * validation dropdowns to Orders, Production, and QC tabs.
   * Safe to call multiple times — rules are additive.
   */
  async applyFormatting(): Promise<void> {
    this.assertInitialized();
    try {
      const ordersSheet = this.getSheet(TAB_NAMES.ORDERS);
      if (!ordersSheet || !this.doc) return;

      const statusColIdx = TAB_HEADERS[TAB_NAMES.ORDERS].indexOf('Status');
      if (statusColIdx === -1) return;

      const statusColors: Record<string, { red: number; green: number; blue: number }> = {
        'New':           { red: 1.0,  green: 0.95, blue: 0.8  },
        'In Production': { red: 0.8,  green: 0.9,  blue: 1.0  },
        'QC':            { red: 1.0,  green: 0.9,  blue: 0.8  },
        'Ready to Ship': { red: 0.85, green: 0.95, blue: 0.85 },
        'Shipped':       { red: 0.7,  green: 0.95, blue: 0.7  },
        'Delivered':     { red: 0.9,  green: 0.9,  blue: 0.9  },
        'Cancelled':     { red: 1.0,  green: 0.85, blue: 0.85 },
        'Refunded':      { red: 1.0,  green: 0.8,  blue: 0.8  },
        'Failed':        { red: 0.95, green: 0.75, blue: 0.75 },
      };

      const statusValues = Object.keys(statusColors);
      const colLetter = String.fromCharCode(65 + statusColIdx);
      const requests: Array<Record<string, unknown>> = [];

      // Conditional formatting rules for each status
      for (const [status, color] of Object.entries(statusColors)) {
        requests.push({
          addConditionalFormatRule: {
            rule: {
              ranges: [{
                sheetId: ordersSheet.sheetId,
                startRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: TAB_HEADERS[TAB_NAMES.ORDERS].length,
              }],
              booleanRule: {
                condition: {
                  type: 'CUSTOM_FORMULA',
                  values: [{ userEnteredValue: `=$${colLetter}2="${status}"` }],
                },
                format: { backgroundColor: color },
              },
            },
            index: 0,
          },
        });
      }

      // Data validation: Orders → Status dropdown
      requests.push({
        setDataValidation: {
          range: {
            sheetId: ordersSheet.sheetId,
            startRowIndex: 1,
            startColumnIndex: statusColIdx,
            endColumnIndex: statusColIdx + 1,
          },
          rule: {
            condition: {
              type: 'ONE_OF_LIST',
              values: statusValues.map((v) => ({ userEnteredValue: v })),
            },
            showCustomUi: true,
            strict: false,
          },
        },
      });

      // Data validation: QC → Pass/Fail dropdown
      const qcSheet = this.getSheet(TAB_NAMES.QC);
      if (qcSheet) {
        const pfIdx = TAB_HEADERS[TAB_NAMES.QC].indexOf('Pass/Fail');
        if (pfIdx !== -1) {
          requests.push({
            setDataValidation: {
              range: {
                sheetId: qcSheet.sheetId,
                startRowIndex: 1,
                startColumnIndex: pfIdx,
                endColumnIndex: pfIdx + 1,
              },
              rule: {
                condition: {
                  type: 'ONE_OF_LIST',
                  values: ['Pending', 'Pass', 'Fail'].map((v) => ({ userEnteredValue: v })),
                },
                showCustomUi: true,
                strict: false,
              },
            },
          });

          // QC row color coding: green=Pass, red=Fail, yellow=Pending
          const pfCol = String.fromCharCode(65 + pfIdx);
          const qcColors: Record<string, { red: number; green: number; blue: number }> = {
            'Pass':    { red: 0.78, green: 0.95, blue: 0.78 },
            'Fail':    { red: 0.96, green: 0.78, blue: 0.78 },
            'Pending': { red: 1.0,  green: 0.96, blue: 0.80 },
          };
          for (const [val, color] of Object.entries(qcColors)) {
            requests.push({
              addConditionalFormatRule: {
                rule: {
                  ranges: [{
                    sheetId: qcSheet.sheetId,
                    startRowIndex: 1,
                    startColumnIndex: 0,
                    endColumnIndex: TAB_HEADERS[TAB_NAMES.QC].length,
                  }],
                  booleanRule: {
                    condition: {
                      type: 'CUSTOM_FORMULA',
                      values: [{ userEnteredValue: `=$${pfCol}2="${val}"` }],
                    },
                    format: { backgroundColor: color },
                  },
                },
                index: 0,
              },
            });
          }
        }
      }

      // Data validation: Production → Status dropdown
      const prodSheet = this.getSheet(TAB_NAMES.PRODUCTION);
      if (prodSheet) {
        const psIdx = TAB_HEADERS[TAB_NAMES.PRODUCTION].indexOf('Status');
        if (psIdx !== -1) {
          requests.push({
            setDataValidation: {
              range: {
                sheetId: prodSheet.sheetId,
                startRowIndex: 1,
                startColumnIndex: psIdx,
                endColumnIndex: psIdx + 1,
              },
              rule: {
                condition: {
                  type: 'ONE_OF_LIST',
                  values: ['In Progress', 'Completed', 'Rework', 'On Hold'].map((v) => ({ userEnteredValue: v })),
                },
                showCustomUi: true,
                strict: false,
              },
            },
          });
        }
      }

      // Execute all formatting via Sheets batchUpdate API
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.doc as any)._makeBatchUpdateRequest(requests);
      logger.info({ ruleCount: requests.length }, 'Sheets formatting applied: color coding + dropdowns');
    } catch (error) {
      logger.error({ err: error }, 'Error applying sheets formatting');
    }
  }

  // ── System Logs tab ─────────────────────────────────────────────────────

  /**
   * Append an event to the System Logs tab for operational visibility.
   * This is fire-and-forget — errors are swallowed so logging never blocks
   * the caller.
   */
  async logEvent(
    level: string,
    source: string,
    message: string,
    details?: string,
  ): Promise<void> {
    try {
      if (!this.initialized) return;

      const sheet = this.getSheet(TAB_NAMES.SYSTEM_LOGS);
      if (!sheet) return;

      await sheet.addRow(
        sanitizeRow({
          Timestamp: new Date().toISOString(),
          Level: level,
          Source: source,
          Message: message,
          Details: details ?? '',
        }),
      );
    } catch (_error) {
      // Intentionally swallowed — we never want log persistence to break
      // the calling workflow.
      logger.debug({ level, source, message }, 'Failed to write system log to sheet');
    }
  }
}

// ── Singleton export ────────────────────────────────────────────────────────

export const sheets = new GoogleSheetsService();
