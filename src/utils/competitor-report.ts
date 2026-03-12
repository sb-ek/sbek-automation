/**
 * Generate a professional PDF competitor analysis report.
 *
 * Uses pdfkit to produce a branded report suitable for sharing
 * with the SBEK client / brand owner.
 */

import PDFDocument from 'pdfkit';
import type { CrawlResult, CrawlProduct } from '../services/crawler.service.js';

// ── Brand colours ─────────────────────────────────────────────────
const C = {
  black: '#111111',
  dark: '#222222',
  text: '#333333',
  muted: '#666666',
  light: '#999999',
  accent: '#B8860B',
  bg: '#F8F6F0',
  line: '#DDD5C5',
  green: '#1D7A3F',
  red: '#CC3333',
  white: '#FFFFFF',
};

const PW = 595.28; // A4 width
const PH = 841.89; // A4 height
const M = 50; // margin
const W = PW - M * 2; // usable width
const BOT = PH - 45; // bottom safe zone (above footer)

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
    bufferPages: true,
    margins: { top: M, bottom: M, left: M, right: M },
    info: {
      Title: filterName
        ? `Competitor Report — ${filterName}`
        : 'Competitor Analysis Report',
      Author: 'SBEK Automation',
      Subject: 'Competitor Intelligence',
    },
  });

  // Group snapshots — keep only latest per competitor
  const latest = new Map<string, SnapshotRow>();
  for (const s of snapshots) {
    if (!latest.has(s.competitorName)) {
      latest.set(s.competitorName, s);
    }
  }

  // ── Cover page ──
  drawCover(doc, filterName, latest.size);

  // ── Competitor sections ──
  for (const [name, snapshot] of latest) {
    doc.addPage();
    drawCompetitor(doc, name, snapshot);
  }

  // ── Summary page (multi-competitor only) ──
  if (latest.size > 1) {
    doc.addPage();
    drawSummary(doc, latest);
  }

  // ── Footer on every page ──
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = PH - 30;
    doc.save();
    doc.moveTo(M, y - 5).lineTo(M + W, y - 5).lineWidth(0.3).strokeColor(C.line).stroke();
    doc.fontSize(6.5).font('Helvetica').fillColor(C.light);
    doc.text('SBEK Automation — Competitor Intelligence', M, y, { lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, M + W - 60, y, { width: 60, align: 'right', lineBreak: false });
    doc.restore();
  }

  doc.end();
  return doc;
}

// ── Helpers ──────────────────────────────────────────────────────

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y > BOT - needed) doc.addPage();
}

function sectionHead(doc: PDFKit.PDFDocument, title: string) {
  ensureSpace(doc, 35);
  const y = doc.y;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(C.line).stroke();
  doc.fontSize(10).font('Helvetica-Bold').fillColor(C.accent).text(title.toUpperCase(), M, y + 6, { characterSpacing: 0.5 });
  doc.moveDown(0.5);
}

function labelValue(doc: PDFKit.PDFDocument, label: string, value: string, labelW = 110) {
  ensureSpace(doc, 16);
  const y = doc.y;
  doc.fontSize(8).font('Helvetica-Bold').fillColor(C.muted).text(label, M + 10, y, { width: labelW });
  doc.fontSize(8).font('Helvetica').fillColor(C.text).text(value, M + 10 + labelW, y, { width: W - labelW - 20 });
  doc.y = Math.max(doc.y, y + 14);
}

function formatPrice(n: number): string {
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ── Cover ────────────────────────────────────────────────────────

function drawCover(doc: PDFKit.PDFDocument, filterName: string | undefined, count: number) {
  doc.rect(0, 0, PW, PH).fill(C.black);

  doc.fontSize(52).fillColor(C.accent).font('Helvetica-Bold');
  doc.text('SBEK', M, 200, { align: 'center' });

  doc.fontSize(11).fillColor(C.light).font('Helvetica');
  doc.text('LUXURY JEWELRY INTELLIGENCE', M, 265, { align: 'center', characterSpacing: 4 });

  const cx = PW / 2;
  doc.moveTo(cx - 70, 300).lineTo(cx + 70, 300).strokeColor(C.accent).lineWidth(1.5).stroke();

  doc.fontSize(24).fillColor(C.white).font('Helvetica-Bold');
  const title = filterName ? `${filterName}\nCompetitor Report` : 'Competitor\nAnalysis Report';
  doc.text(title, M, 330, { align: 'center', lineGap: 6 });

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.fontSize(10).fillColor(C.light).font('Helvetica');
  doc.text(`Generated: ${dateStr}`, M, 430, { align: 'center' });
  doc.text(`Competitors analysed: ${count}`, M, 450, { align: 'center' });

  doc.fontSize(8).fillColor(C.muted).font('Helvetica');
  doc.text('Confidential — For internal use only', M, PH - 80, { align: 'center' });
}

// ── Competitor Section ───────────────────────────────────────────

function drawCompetitor(doc: PDFKit.PDFDocument, name: string, snapshot: SnapshotRow) {
  const data = snapshot.data as CrawlResult | null;

  // ── Header bar ──
  doc.rect(0, 40, PW, 48).fill(C.black);
  doc.fontSize(20).fillColor(C.accent).font('Helvetica-Bold');
  doc.text(name.toUpperCase(), M, 48);
  doc.fontSize(9).fillColor(C.light).font('Helvetica');
  doc.text(snapshot.url, M, 70);
  doc.y = 100;

  if (!data) {
    doc.fontSize(11).fillColor(C.muted).font('Helvetica');
    doc.text('No crawl data available — this competitor may be blocking automated access.', M, 110, { width: W });
    doc.text('Try crawling again or check if the URL is correct.', M, 130, { width: W });
    return;
  }

  // ── Crawl date ──
  const crawlDate = snapshot.crawledAt
    ? new Date(snapshot.crawledAt).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Unknown';
  doc.fontSize(8).fillColor(C.muted).font('Helvetica');
  doc.text(`Last crawled: ${crawlDate}`, M, doc.y);
  doc.moveDown(0.5);

  // ── Metrics Row ──
  const metrics = [
    { label: 'Products', val: String(data.products?.length ?? 0), color: (data.products?.length ?? 0) > 0 ? C.green : C.red },
    { label: 'Pages', val: String(data.pageCount ?? 0), color: C.dark },
    { label: 'Schema', val: data.techSeo?.hasSchema ? 'Yes' : 'No', color: data.techSeo?.hasSchema ? C.green : C.red },
    { label: 'OpenGraph', val: data.techSeo?.hasOpenGraph ? 'Yes' : 'No', color: data.techSeo?.hasOpenGraph ? C.green : C.red },
    { label: 'Sitemap', val: data.techSeo?.hasSitemap ? 'Found' : 'Missing', color: data.techSeo?.hasSitemap ? C.green : C.red },
  ];

  const bw = (W - 32) / metrics.length;
  const my = doc.y;
  for (let i = 0; i < metrics.length; i++) {
    const bx = M + i * (bw + 8);
    doc.rect(bx, my, bw, 46).fillAndStroke(C.bg, C.line);
    doc.fontSize(18).fillColor(metrics[i].color).font('Helvetica-Bold');
    doc.text(metrics[i].val, bx, my + 5, { width: bw, align: 'center' });
    doc.fontSize(7).fillColor(C.muted).font('Helvetica');
    doc.text(metrics[i].label, bx, my + 30, { width: bw, align: 'center' });
  }
  doc.y = my + 58;

  // ── SEO Analysis ──
  sectionHead(doc, 'SEO Analysis');

  labelValue(doc, 'Page Title', trunc(data.title || 'N/A', 90));
  labelValue(doc, 'Meta Description', trunc(data.meta?.description || 'Not found', 140));
  labelValue(doc, 'Keywords', trunc(data.meta?.keywords?.join(', ') || 'None', 120));
  labelValue(doc, 'Schema Types', trunc(data.techSeo?.schemaTypes?.join(', ') || 'None', 120));
  labelValue(doc, 'H1 Tags', trunc(data.techSeo?.h1Tags?.join(' | ') || 'None', 120));
  labelValue(doc, 'Canonical', trunc(data.meta?.canonical || 'Not set', 90));

  // H2 topics if available
  const h2s = data.techSeo?.h2Tags ?? [];
  if (h2s.length > 0) {
    doc.moveDown(0.2);
    labelValue(doc, 'H2 Topics', trunc(h2s.slice(0, 5).join('  •  '), 200));
  }

  // ── Products ──
  const products = data.products ?? [];
  if (products.length > 0) {
    doc.moveDown(0.3);
    sectionHead(doc, `Products Found (${products.length})`);

    // Table header
    ensureSpace(doc, 22);
    const ty = doc.y;
    doc.rect(M, ty, W, 20).fill(C.black);
    doc.fontSize(7.5).fillColor(C.white).font('Helvetica-Bold');
    doc.text('#', M + 8, ty + 5, { width: 22 });
    doc.text('Product Name', M + 30, ty + 5, { width: 300 });
    doc.text('Price (INR)', M + W - 90, ty + 5, { width: 80, align: 'right' });
    doc.y = ty + 22;

    // Product rows (max 20)
    const display = products.slice(0, 20);
    for (let i = 0; i < display.length; i++) {
      ensureSpace(doc, 18);
      const ry = doc.y;
      const stripe = i % 2 === 0 ? C.bg : C.white;
      doc.rect(M, ry, W, 16).fill(stripe);
      doc.fontSize(7.5).fillColor(C.text).font('Helvetica');
      doc.text(String(i + 1), M + 8, ry + 4, { width: 22 });
      doc.text(trunc(display[i].name, 60), M + 30, ry + 4, { width: 300 });
      doc.fillColor(display[i].price > 0 ? C.text : C.light);
      doc.text(display[i].price > 0 ? formatPrice(display[i].price) : '—', M + W - 90, ry + 4, { width: 80, align: 'right' });
      doc.y = ry + 16;
    }

    if (products.length > 20) {
      doc.fontSize(7.5).fillColor(C.muted).font('Helvetica');
      doc.text(`... and ${products.length - 20} more products`, M + 30, doc.y + 3);
      doc.moveDown(0.3);
    }

    // Price summary
    const priced = products.filter((p: CrawlProduct) => p.price > 0);
    if (priced.length > 0) {
      ensureSpace(doc, 28);
      doc.moveDown(0.2);
      const sy = doc.y;
      const sorted = priced.map((p: CrawlProduct) => p.price).sort((a: number, b: number) => a - b);
      const avg = sorted.reduce((a: number, b: number) => a + b, 0) / sorted.length;
      doc.rect(M, sy, W, 22).fillAndStroke(C.bg, C.line);
      doc.fontSize(8).fillColor(C.muted).font('Helvetica-Bold');
      doc.text(`Price Range: ${formatPrice(sorted[0])} — ${formatPrice(sorted[sorted.length - 1])}    |    Average: ${formatPrice(avg)}    |    ${priced.length} priced products`, M + 10, sy + 6, { width: W - 20 });
      doc.y = sy + 28;
    }
  }

  // ── Site Structure ──
  const links = data.links ?? [];
  if (links.length > 0) {
    doc.moveDown(0.3);
    sectionHead(doc, `Site Structure (${links.length} internal links)`);

    const sample = links.slice(0, 10);
    for (const link of sample) {
      ensureSpace(doc, 13);
      doc.fontSize(7.5).fillColor(C.muted).font('Helvetica');
      doc.text(`•  ${trunc(link, 85)}`, M + 10, doc.y);
      doc.moveDown(0.05);
    }
    if (links.length > 10) {
      doc.fontSize(7.5).fillColor(C.light).font('Helvetica');
      doc.text(`... and ${links.length - 10} more`, M + 10, doc.y);
    }
  }
}

// ── Summary Page ─────────────────────────────────────────────────

function drawSummary(doc: PDFKit.PDFDocument, competitors: Map<string, SnapshotRow>) {
  // Header bar
  doc.rect(0, 40, PW, 42).fill(C.black);
  doc.fontSize(17).fillColor(C.accent).font('Helvetica-Bold');
  doc.text('COMPETITIVE LANDSCAPE SUMMARY', M, 50);
  doc.y = 100;

  // Comparison table
  const colX = { name: M, products: M + 135, schema: M + 210, og: M + 280, sitemap: M + 345, price: M + 410 };
  const colW = { name: 130, products: 70, schema: 65, og: 60, sitemap: 60, price: 80 };

  const hy = doc.y;
  doc.rect(M, hy, W, 22).fill(C.black);
  doc.fontSize(7.5).fillColor(C.white).font('Helvetica-Bold');
  doc.text('Competitor', colX.name + 8, hy + 6, { width: colW.name });
  doc.text('Products', colX.products, hy + 6, { width: colW.products, align: 'center' });
  doc.text('Schema', colX.schema, hy + 6, { width: colW.schema, align: 'center' });
  doc.text('OG Tags', colX.og, hy + 6, { width: colW.og, align: 'center' });
  doc.text('Sitemap', colX.sitemap, hy + 6, { width: colW.sitemap, align: 'center' });
  doc.text('Avg Price', colX.price, hy + 6, { width: colW.price, align: 'right' });
  doc.y = hy + 24;

  let i = 0;
  for (const [name, snapshot] of competitors) {
    ensureSpace(doc, 20);
    const ry = doc.y;
    const data = snapshot.data as CrawlResult | null;
    const stripe = i % 2 === 0 ? C.bg : C.white;
    doc.rect(M, ry, W, 20).fill(stripe);

    doc.fontSize(8).fillColor(C.dark).font('Helvetica-Bold');
    doc.text(trunc(name, 22), colX.name + 8, ry + 5, { width: colW.name });

    doc.font('Helvetica').fontSize(8);
    const prods = data?.products ?? [];
    doc.fillColor(prods.length > 0 ? C.green : C.light);
    doc.text(String(prods.length), colX.products, ry + 5, { width: colW.products, align: 'center' });

    doc.fillColor(data?.techSeo?.hasSchema ? C.green : C.red);
    doc.text(data?.techSeo?.hasSchema ? 'Yes' : 'No', colX.schema, ry + 5, { width: colW.schema, align: 'center' });

    doc.fillColor(data?.techSeo?.hasOpenGraph ? C.green : C.red);
    doc.text(data?.techSeo?.hasOpenGraph ? 'Yes' : 'No', colX.og, ry + 5, { width: colW.og, align: 'center' });

    doc.fillColor(data?.techSeo?.hasSitemap ? C.green : C.red);
    doc.text(data?.techSeo?.hasSitemap ? 'Yes' : 'No', colX.sitemap, ry + 5, { width: colW.sitemap, align: 'center' });

    const priced = prods.filter((p: CrawlProduct) => p.price > 0);
    const avg = priced.length > 0 ? priced.reduce((s: number, p: CrawlProduct) => s + p.price, 0) / priced.length : 0;
    doc.fillColor(C.dark);
    doc.text(avg > 0 ? formatPrice(avg) : '—', colX.price, ry + 5, { width: colW.price, align: 'right' });

    doc.y = ry + 20;
    i++;
  }

  // Key Insights
  doc.moveDown(1);
  sectionHead(doc, 'Key Insights');

  const allData = [...competitors.values()].map(s => s.data as CrawlResult | null).filter(Boolean) as CrawlResult[];
  const insights: string[] = [];

  const withProducts = allData.filter(d => (d.products?.length ?? 0) > 0);
  insights.push(`${withProducts.length} of ${allData.length} competitors have visible product listings on their website.`);

  const withSchema = allData.filter(d => d.techSeo?.hasSchema);
  insights.push(`${withSchema.length} of ${allData.length} competitors use structured data (Schema.org markup) — important for Google rich results.`);

  const withSitemap = allData.filter(d => d.techSeo?.hasSitemap);
  insights.push(`${withSitemap.length} of ${allData.length} competitors have a publicly accessible sitemap.xml.`);

  const withOG = allData.filter(d => d.techSeo?.hasOpenGraph);
  insights.push(`${withOG.length} of ${allData.length} competitors use Open Graph tags for social media sharing.`);

  const allProducts = allData.flatMap(d => d.products ?? []).filter(p => p.price > 0);
  if (allProducts.length > 0) {
    const prices = allProducts.map(p => p.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    insights.push(`Across all competitors, the median product price is ${formatPrice(median)} (${allProducts.length} products with prices tracked).`);
  }

  // Total pages crawled
  const totalPages = allData.reduce((s, d) => s + (d.pageCount ?? 0), 0);
  insights.push(`Total pages crawled across all competitors: ${totalPages}.`);

  for (const insight of insights) {
    ensureSpace(doc, 18);
    doc.fontSize(9).fillColor(C.text).font('Helvetica');
    doc.text(`•  ${insight}`, M + 10, doc.y, { width: W - 20 });
    doc.moveDown(0.3);
  }
}
