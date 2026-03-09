/**
 * Generate a professional PDF competitor analysis report.
 *
 * Uses pdfkit to produce a branded report suitable for sharing
 * with the SBEK client / brand owner.
 */

import PDFDocument from 'pdfkit';
import type { CrawlResult, CrawlProduct } from '../services/crawler.service.js';

// ── Brand colours ─────────────────────────────────────────────────
const BRAND = {
  black: '#111111',
  dark: '#333333',
  muted: '#666666',
  light: '#999999',
  accent: '#B8860B', // dark gold — luxury jewelry feel
  bg: '#FAFAF7',
  line: '#E0D8C8',
  green: '#2D8A4E',
  red: '#CC3333',
  white: '#FFFFFF',
};

interface SnapshotRow {
  competitorName: string;
  url: string;
  crawledAt: Date | string | null;
  data: unknown;
}

// ── Public API ────────────────────────────────────────────────────

export function generateCompetitorReport(
  snapshots: SnapshotRow[],
  filterName?: string,
): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    info: {
      Title: filterName
        ? `Competitor Report — ${filterName}`
        : 'Competitor Analysis Report',
      Author: 'SBEK Automation',
      Subject: 'Competitor Intelligence',
    },
  });

  // Group snapshots by competitor — keep only the latest per competitor
  const latest = new Map<string, SnapshotRow>();
  for (const s of snapshots) {
    if (!latest.has(s.competitorName)) {
      latest.set(s.competitorName, s);
    }
  }

  // ── Cover page ──────────────────────────────────────────────────
  drawCoverPage(doc, filterName, latest.size);

  // ── Competitor sections (each on a new page after the cover) ───
  for (const [name, snapshot] of latest) {
    doc.addPage();
    drawCompetitorSection(doc, name, snapshot);
  }

  // ── Summary page ────────────────────────────────────────────────
  if (latest.size > 1) {
    doc.addPage();
    drawSummaryPage(doc, latest);
  }

  // Footer on every page
  const totalPages = doc.bufferedPageRange();
  for (let i = 0; i < totalPages.count; i++) {
    doc.switchToPage(i);
    drawFooter(doc, i + 1, totalPages.count);
  }

  doc.end();
  return doc;
}

// ── Drawing helpers ───────────────────────────────────────────────

function drawCoverPage(doc: PDFKit.PDFDocument, filterName: string | undefined, competitorCount: number) {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(BRAND.black);

  // Brand mark — centered vertically in upper third
  doc.fontSize(56).fillColor(BRAND.accent).font('Helvetica-Bold');
  doc.text('SBEK', 50, 220, { align: 'center' });

  // Subtitle
  doc.fontSize(13).fillColor(BRAND.light).font('Helvetica');
  doc.text('LUXURY JEWELRY INTELLIGENCE', 50, 290, { align: 'center', characterSpacing: 3 });

  // Divider
  const cx = doc.page.width / 2;
  doc.moveTo(cx - 80, 330).lineTo(cx + 80, 330).strokeColor(BRAND.accent).lineWidth(1.5).stroke();

  // Report title
  doc.fontSize(26).fillColor(BRAND.white).font('Helvetica-Bold');
  const title = filterName ? `${filterName}\nCompetitor Report` : 'Competitor\nAnalysis Report';
  doc.text(title, 50, 360, { align: 'center', lineGap: 6 });

  // Meta info — lower section
  doc.fontSize(11).fillColor(BRAND.light).font('Helvetica');
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.text(`Generated: ${dateStr}`, 50, 480, { align: 'center' });
  doc.text(`Competitors analysed: ${competitorCount}`, 50, 502, { align: 'center' });

  // Confidential — near bottom
  doc.fontSize(9).fillColor(BRAND.muted).font('Helvetica');
  doc.text('Confidential — For internal use only', 50, doc.page.height - 80, { align: 'center' });
}

function drawCompetitorSection(doc: PDFKit.PDFDocument, name: string, snapshot: SnapshotRow) {
  const data = snapshot.data as CrawlResult | null;
  if (!data) {
    // Still render a minimal section for competitors with no crawl data
    let y = 50;
    doc.rect(0, y - 10, doc.page.width, 45).fill(BRAND.black);
    doc.fontSize(20).fillColor(BRAND.accent).font('Helvetica-Bold');
    doc.text(name.toUpperCase(), 50, y, { continued: false });
    doc.fontSize(10).fillColor(BRAND.light).font('Helvetica');
    doc.text(snapshot.url, 50, y + 24);
    y += 65;
    doc.fontSize(12).fillColor(BRAND.muted).font('Helvetica');
    doc.text('No crawl data available — this competitor may be blocking automated access.', 50, y, { width: 495 });
    doc.text('Try crawling again or check if the URL is correct.', 50, y + 20, { width: 495 });
    return;
  }

  let y = 50;

  // Competitor header bar
  doc.rect(0, y - 10, doc.page.width, 45).fill(BRAND.black);
  doc.fontSize(20).fillColor(BRAND.accent).font('Helvetica-Bold');
  doc.text(name.toUpperCase(), 50, y, { continued: false });
  doc.fontSize(10).fillColor(BRAND.light).font('Helvetica');
  doc.text(snapshot.url, 50, y + 24);
  y += 55;

  // Crawl date
  const crawlDate = snapshot.crawledAt
    ? new Date(snapshot.crawledAt).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Unknown';
  doc.fontSize(9).fillColor(BRAND.muted).font('Helvetica');
  doc.text(`Last crawled: ${crawlDate}`, 50, y);
  y += 20;

  // ── Key Metrics Row ──
  const metrics = [
    { label: 'Products Found', value: String(data.products?.length ?? 0), color: (data.products?.length ?? 0) > 0 ? BRAND.green : BRAND.red },
    { label: 'Pages Scraped', value: String(data.pageCount ?? 0), color: BRAND.dark },
    { label: 'Schema Markup', value: data.techSeo?.hasSchema ? 'Yes' : 'No', color: data.techSeo?.hasSchema ? BRAND.green : BRAND.red },
    { label: 'Open Graph', value: data.techSeo?.hasOpenGraph ? 'Yes' : 'No', color: data.techSeo?.hasOpenGraph ? BRAND.green : BRAND.red },
    { label: 'Sitemap', value: data.techSeo?.hasSitemap ? 'Found' : 'Missing', color: data.techSeo?.hasSitemap ? BRAND.green : BRAND.red },
  ];

  const boxW = (doc.page.width - 100 - 40) / metrics.length;
  for (let i = 0; i < metrics.length; i++) {
    const bx = 50 + i * (boxW + 10);
    doc.rect(bx, y, boxW, 50).fillAndStroke(BRAND.bg, BRAND.line);
    doc.fontSize(18).fillColor(metrics[i].color).font('Helvetica-Bold');
    doc.text(metrics[i].value, bx, y + 6, { width: boxW, align: 'center' });
    doc.fontSize(7).fillColor(BRAND.muted).font('Helvetica');
    doc.text(metrics[i].label, bx, y + 32, { width: boxW, align: 'center' });
  }
  y += 65;

  // ── SEO Analysis ──
  y = sectionTitle(doc, 'SEO Analysis', y);

  const pageTitle = data.title || 'N/A';
  const desc = data.meta?.description || 'No meta description found';
  const keywords = data.meta?.keywords?.join(', ') || 'None';
  const schemaTypes = data.techSeo?.schemaTypes?.join(', ') || 'None';
  const h1s = data.techSeo?.h1Tags?.join(' | ') || 'None';

  const seoRows = [
    ['Page Title', pageTitle.slice(0, 80)],
    ['Meta Description', desc.slice(0, 120)],
    ['Keywords', keywords.slice(0, 100)],
    ['Schema Types', schemaTypes.slice(0, 100)],
    ['H1 Tags', h1s.slice(0, 100)],
    ['Canonical', data.meta?.canonical || 'Not set'],
  ];

  for (const [label, value] of seoRows) {
    if (y > 720) { doc.addPage(); y = 50; }
    doc.fontSize(9).fillColor(BRAND.muted).font('Helvetica-Bold');
    doc.text(label, 60, y, { width: 100 });
    doc.fontSize(9).fillColor(BRAND.dark).font('Helvetica');
    doc.text(value, 170, y, { width: 370 });
    y += Math.max(20, doc.heightOfString(value, { width: 370 }) + 6);
  }

  y += 10;

  // ── Top Products ──
  const products = data.products ?? [];
  if (products.length > 0) {
    if (y > 580) { doc.addPage(); y = 50; }
    y = sectionTitle(doc, `Products Found (${products.length})`, y);

    // Table header
    doc.rect(50, y, doc.page.width - 100, 20).fill(BRAND.black);
    doc.fontSize(8).fillColor(BRAND.white).font('Helvetica-Bold');
    doc.text('#', 55, y + 5, { width: 25 });
    doc.text('Product Name', 80, y + 5, { width: 280 });
    doc.text('Price (INR)', 370, y + 5, { width: 80, align: 'right' });
    y += 22;

    // Product rows (max 20)
    const displayProducts = products.slice(0, 20);
    for (let i = 0; i < displayProducts.length; i++) {
      if (y > 720) { doc.addPage(); y = 50; }
      const p = displayProducts[i];
      const stripe = i % 2 === 0 ? BRAND.bg : BRAND.white;
      doc.rect(50, y, doc.page.width - 100, 18).fill(stripe);
      doc.fontSize(8).fillColor(BRAND.dark).font('Helvetica');
      doc.text(String(i + 1), 55, y + 4, { width: 25 });
      doc.text(truncate(p.name, 55), 80, y + 4, { width: 280 });
      doc.fillColor(p.price > 0 ? BRAND.dark : BRAND.light);
      doc.text(p.price > 0 ? formatPrice(p.price) : '—', 370, y + 4, { width: 80, align: 'right' });
      y += 18;
    }

    if (products.length > 20) {
      doc.fontSize(8).fillColor(BRAND.muted).font('Helvetica');
      doc.text(`... and ${products.length - 20} more products`, 80, y + 4);
      y += 20;
    }

    // Price summary
    const pricesWithValues = products.filter((p: CrawlProduct) => p.price > 0);
    if (pricesWithValues.length > 0) {
      y += 8;
      const sorted = pricesWithValues.map((p: CrawlProduct) => p.price).sort((a: number, b: number) => a - b);
      const avg = sorted.reduce((a: number, b: number) => a + b, 0) / sorted.length;
      const min = sorted[0];
      const max = sorted[sorted.length - 1];

      doc.rect(50, y, doc.page.width - 100, 25).fillAndStroke(BRAND.bg, BRAND.line);
      doc.fontSize(8).fillColor(BRAND.muted).font('Helvetica-Bold');
      doc.text(`Price Range: ${formatPrice(min)} — ${formatPrice(max)}    |    Average: ${formatPrice(avg)}    |    ${pricesWithValues.length} priced products`, 60, y + 8);
      y += 35;
    }
  }

  // ── Internal Links ──
  const links = data.links ?? [];
  if (links.length > 0 && y < 650) {
    y = sectionTitle(doc, `Site Structure (${links.length} internal links)`, y);
    const sampleLinks = links.slice(0, 10);
    for (const link of sampleLinks) {
      if (y > 720) break;
      doc.fontSize(8).fillColor(BRAND.muted).font('Helvetica');
      doc.text(`• ${link.slice(0, 80)}`, 60, y);
      y += 13;
    }
    if (links.length > 10) {
      doc.text(`... and ${links.length - 10} more`, 60, y);
    }
  }
}

function drawSummaryPage(doc: PDFKit.PDFDocument, competitors: Map<string, SnapshotRow>) {
  let y = 50;

  doc.rect(0, y - 10, doc.page.width, 40).fill(BRAND.black);
  doc.fontSize(18).fillColor(BRAND.accent).font('Helvetica-Bold');
  doc.text('COMPETITIVE LANDSCAPE SUMMARY', 50, y + 2);
  y += 50;

  // Comparison table header
  const cols = { name: 50, products: 180, schema: 270, og: 340, sitemap: 410, price: 460 };
  doc.rect(50, y, doc.page.width - 100, 22).fill(BRAND.black);
  doc.fontSize(8).fillColor(BRAND.white).font('Helvetica-Bold');
  doc.text('Competitor', cols.name + 5, y + 6);
  doc.text('Products', cols.products, y + 6, { width: 70, align: 'center' });
  doc.text('Schema', cols.schema, y + 6, { width: 55, align: 'center' });
  doc.text('OG Tags', cols.og, y + 6, { width: 55, align: 'center' });
  doc.text('Sitemap', cols.sitemap, y + 6, { width: 45, align: 'center' });
  doc.text('Avg Price', cols.price, y + 6, { width: 80, align: 'right' });
  y += 24;

  let i = 0;
  for (const [name, snapshot] of competitors) {
    const data = snapshot.data as CrawlResult | null;
    const stripe = i % 2 === 0 ? BRAND.bg : BRAND.white;
    doc.rect(50, y, doc.page.width - 100, 20).fill(stripe);

    doc.fontSize(9).fillColor(BRAND.dark).font('Helvetica-Bold');
    doc.text(name, cols.name + 5, y + 5, { width: 120 });

    doc.font('Helvetica').fontSize(9);
    const products = data?.products ?? [];
    doc.fillColor(products.length > 0 ? BRAND.green : BRAND.light);
    doc.text(String(products.length), cols.products, y + 5, { width: 70, align: 'center' });

    doc.fillColor(data?.techSeo?.hasSchema ? BRAND.green : BRAND.red);
    doc.text(data?.techSeo?.hasSchema ? 'Yes' : 'No', cols.schema, y + 5, { width: 55, align: 'center' });

    doc.fillColor(data?.techSeo?.hasOpenGraph ? BRAND.green : BRAND.red);
    doc.text(data?.techSeo?.hasOpenGraph ? 'Yes' : 'No', cols.og, y + 5, { width: 55, align: 'center' });

    doc.fillColor(data?.techSeo?.hasSitemap ? BRAND.green : BRAND.red);
    doc.text(data?.techSeo?.hasSitemap ? 'Yes' : 'No', cols.sitemap, y + 5, { width: 45, align: 'center' });

    const priced = products.filter((p: CrawlProduct) => p.price > 0);
    const avg = priced.length > 0 ? priced.reduce((s: number, p: CrawlProduct) => s + p.price, 0) / priced.length : 0;
    doc.fillColor(BRAND.dark);
    doc.text(avg > 0 ? formatPrice(avg) : '—', cols.price, y + 5, { width: 80, align: 'right' });

    y += 20;
    i++;
  }

  // Key insights
  y += 25;
  y = sectionTitle(doc, 'Key Insights', y);

  const allData = [...competitors.values()].map(s => s.data as CrawlResult | null).filter(Boolean) as CrawlResult[];
  const insights: string[] = [];

  const withProducts = allData.filter(d => (d.products?.length ?? 0) > 0);
  insights.push(`${withProducts.length} of ${allData.length} competitors have visible product listings.`);

  const withSchema = allData.filter(d => d.techSeo?.hasSchema);
  insights.push(`${withSchema.length} of ${allData.length} competitors use structured data (Schema.org markup).`);

  const withSitemap = allData.filter(d => d.techSeo?.hasSitemap);
  insights.push(`${withSitemap.length} of ${allData.length} competitors have a publicly accessible sitemap.xml.`);

  const allProducts = allData.flatMap(d => d.products ?? []).filter(p => p.price > 0);
  if (allProducts.length > 0) {
    const prices = allProducts.map(p => p.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    insights.push(`Across all competitors, the median product price is ${formatPrice(median)} (${allProducts.length} products tracked).`);
  }

  for (const insight of insights) {
    doc.fontSize(9).fillColor(BRAND.dark).font('Helvetica');
    doc.text(`•  ${insight}`, 60, y, { width: 460 });
    y += 18;
  }
}

function drawFooter(doc: PDFKit.PDFDocument, pageNum: number, totalPages: number) {
  const y = doc.page.height - 30;
  doc.fontSize(7).fillColor(BRAND.light).font('Helvetica');
  doc.text('SBEK Automation — Competitor Intelligence Report', 50, y);
  doc.text(`Page ${pageNum} of ${totalPages}`, doc.page.width - 120, y, { width: 70, align: 'right' });
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string, y: number): number {
  doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(BRAND.line).lineWidth(0.5).stroke();
  y += 8;
  doc.fontSize(11).fillColor(BRAND.accent).font('Helvetica-Bold');
  doc.text(text.toUpperCase(), 50, y);
  y += 20;
  return y;
}

// ── Formatting ────────────────────────────────────────────────────

function formatPrice(n: number): string {
  // Indian number format: ₹1,23,456
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}
