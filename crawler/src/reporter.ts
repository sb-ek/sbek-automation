import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AnalysisResult, PriceChange } from "./analyzer.js";

// ─── Main report generator ───────────────────────────────────────────────────

/**
 * Generate a styled HTML report from an analysis result.
 * Saves to `{reportsDir}/{date}-{domain}.html` and returns the HTML string.
 */
export function generateReport(
  analysis: AnalysisResult,
  competitorName: string,
  reportsDir = "/app/reports",
): string {
  const html = buildHtml(analysis, competitorName);

  // Persist the report to disk
  try {
    mkdirSync(reportsDir, { recursive: true });

    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const safeName = competitorName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const filename = `${dateStr}-${safeName}.html`;
    const filepath = path.join(reportsDir, filename);

    writeFileSync(filepath, html, "utf-8");
    console.log(`[reporter] Report saved to ${filepath}`);
  } catch (err) {
    console.error("[reporter] Failed to save report:", err);
  }

  return html;
}

// ─── HTML builder ────────────────────────────────────────────────────────────

function buildHtml(analysis: AnalysisResult, competitorName: string): string {
  const {
    url,
    analyzedAt,
    productCount,
    previousProductCount: _previousProductCount,
    productCountDelta,
    newProducts,
    removedProducts,
    priceChanges,
    newBlogPosts,
    contentFreshnessScore,
    seoScore,
    hasPreviousData,
    summary,
    currentCrawl,
  } = analysis;

  const dateFormatted = new Date(analyzedAt).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const timeFormatted = new Date(analyzedAt).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Competitor Report: ${escapeHtml(competitorName)} - ${dateFormatted}</title>
  <style>
    :root {
      --primary: #1a1a2e;
      --accent: #e94560;
      --success: #0f9b58;
      --warning: #f5a623;
      --danger: #e94560;
      --bg: #f8f9fa;
      --card-bg: #ffffff;
      --text: #333333;
      --text-light: #6c757d;
      --border: #dee2e6;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
    }

    .header {
      background: var(--primary);
      color: white;
      padding: 2rem;
      text-align: center;
    }

    .header h1 {
      font-size: 1.75rem;
      margin-bottom: 0.5rem;
    }

    .header .subtitle {
      font-size: 0.95rem;
      opacity: 0.8;
    }

    .header .url {
      font-size: 0.85rem;
      opacity: 0.6;
      margin-top: 0.25rem;
      word-break: break-all;
    }

    .container {
      max-width: 960px;
      margin: 0 auto;
      padding: 2rem 1rem;
    }

    .summary-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
      text-align: center;
    }

    .stat-card .value {
      font-size: 2rem;
      font-weight: 700;
      color: var(--primary);
    }

    .stat-card .value.positive { color: var(--success); }
    .stat-card .value.negative { color: var(--danger); }

    .stat-card .label {
      font-size: 0.85rem;
      color: var(--text-light);
      margin-top: 0.25rem;
    }

    .section {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 1.5rem;
      overflow: hidden;
    }

    .section-header {
      background: var(--primary);
      color: white;
      padding: 0.75rem 1.25rem;
      font-size: 1rem;
      font-weight: 600;
    }

    .section-body {
      padding: 1.25rem;
    }

    .summary-text {
      font-size: 0.95rem;
      line-height: 1.7;
      color: var(--text);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }

    th {
      background: #f1f3f5;
      text-align: left;
      padding: 0.6rem 0.75rem;
      font-weight: 600;
      border-bottom: 2px solid var(--border);
    }

    td {
      padding: 0.6rem 0.75rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }

    tr:last-child td { border-bottom: none; }

    .badge {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .badge-new { background: #d4edda; color: #155724; }
    .badge-removed { background: #f8d7da; color: #721c24; }
    .badge-increase { background: #f8d7da; color: #721c24; }
    .badge-decrease { background: #d4edda; color: #155724; }

    .seo-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.75rem;
    }

    .seo-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.9rem;
    }

    .seo-check {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      color: white;
      flex-shrink: 0;
    }

    .seo-check.pass { background: var(--success); }
    .seo-check.fail { background: var(--danger); }

    .freshness-bar {
      background: #e9ecef;
      border-radius: 8px;
      height: 24px;
      overflow: hidden;
      margin-top: 0.5rem;
    }

    .freshness-fill {
      height: 100%;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 0.75rem;
      font-weight: 600;
      transition: width 0.3s ease;
    }

    .freshness-fill.high { background: var(--success); }
    .freshness-fill.medium { background: var(--warning); }
    .freshness-fill.low { background: var(--danger); }

    .empty-state {
      color: var(--text-light);
      font-style: italic;
      font-size: 0.9rem;
      padding: 0.5rem 0;
    }

    .product-link {
      color: var(--accent);
      text-decoration: none;
    }

    .product-link:hover {
      text-decoration: underline;
    }

    .homepage-meta dt {
      font-weight: 600;
      margin-top: 0.75rem;
      font-size: 0.85rem;
      color: var(--text-light);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .homepage-meta dd {
      margin-left: 0;
      font-size: 0.95rem;
    }

    .footer {
      text-align: center;
      padding: 2rem 1rem;
      font-size: 0.8rem;
      color: var(--text-light);
    }
  </style>
</head>
<body>

<div class="header">
  <h1>Competitor Analysis: ${escapeHtml(competitorName)}</h1>
  <div class="subtitle">${dateFormatted} at ${timeFormatted}</div>
  <div class="url">${escapeHtml(url)}</div>
</div>

<div class="container">

  <!-- Summary Stats -->
  <div class="summary-bar">
    <div class="stat-card">
      <div class="value">${productCount}</div>
      <div class="label">Products Found</div>
    </div>
    <div class="stat-card">
      <div class="value ${productCountDelta > 0 ? "positive" : productCountDelta < 0 ? "negative" : ""}">${hasPreviousData ? formatDelta(productCountDelta) : "N/A"}</div>
      <div class="label">Product Delta</div>
    </div>
    <div class="stat-card">
      <div class="value">${currentCrawl.blogPosts.length}</div>
      <div class="label">Blog Posts</div>
    </div>
    <div class="stat-card">
      <div class="value ${freshnessClass(contentFreshnessScore)}">${contentFreshnessScore}</div>
      <div class="label">Freshness Score</div>
    </div>
  </div>

  <!-- Summary -->
  <div class="section">
    <div class="section-header">Summary</div>
    <div class="section-body">
      <p class="summary-text">${escapeHtml(summary)}</p>
    </div>
  </div>

  <!-- Homepage Metadata -->
  <div class="section">
    <div class="section-header">Homepage Metadata</div>
    <div class="section-body">
      <dl class="homepage-meta">
        <dt>Title</dt>
        <dd>${escapeHtml(currentCrawl.homepage.title || "(not found)")}</dd>
        <dt>Meta Description</dt>
        <dd>${escapeHtml(currentCrawl.homepage.metaDescription || "(not found)")}</dd>
        <dt>H1 Tags</dt>
        <dd>${currentCrawl.homepage.h1.length > 0 ? currentCrawl.homepage.h1.map(escapeHtml).join(", ") : "(none)"}</dd>
        <dt>Meta Keywords</dt>
        <dd>${escapeHtml(currentCrawl.homepage.metaKeywords || "(not set)")}</dd>
        <dt>OG Image</dt>
        <dd>${currentCrawl.homepage.ogImage ? `<a class="product-link" href="${escapeAttr(currentCrawl.homepage.ogImage)}" target="_blank">${escapeHtml(currentCrawl.homepage.ogImage)}</a>` : "(not set)"}</dd>
      </dl>
    </div>
  </div>

  <!-- SEO Score -->
  <div class="section">
    <div class="section-header">SEO Health</div>
    <div class="section-body">
      <div class="seo-grid">
        ${seoCheckItem("Meta Description", seoScore.hasMetaDescription)}
        ${seoCheckItem("H1 Tag", seoScore.hasH1)}
        ${seoCheckItem("Open Graph Tags", seoScore.hasOgTags)}
        ${seoCheckItem("Structured Data (JSON-LD)", seoScore.hasStructuredData)}
      </div>
    </div>
  </div>

  <!-- Content Freshness -->
  <div class="section">
    <div class="section-header">Content Freshness</div>
    <div class="section-body">
      <div>Score: <strong>${contentFreshnessScore} / 100</strong></div>
      <div class="freshness-bar">
        <div class="freshness-fill ${contentFreshnessScore >= 70 ? "high" : contentFreshnessScore >= 40 ? "medium" : "low"}"
             style="width: ${contentFreshnessScore}%">
          ${contentFreshnessScore}%
        </div>
      </div>
    </div>
  </div>

  <!-- Product Changes -->
  ${hasPreviousData ? buildProductChangesSection(newProducts, removedProducts) : ""}

  <!-- Price Changes -->
  ${priceChanges.length > 0 ? buildPriceChangesSection(priceChanges) : ""}

  <!-- Current Products -->
  <div class="section">
    <div class="section-header">Products (${productCount})</div>
    <div class="section-body">
      ${productCount > 0 ? buildProductsTable(currentCrawl.products) : '<p class="empty-state">No products found on this site.</p>'}
    </div>
  </div>

  <!-- New Content / Blog Posts -->
  <div class="section">
    <div class="section-header">Blog Posts &amp; Content (${currentCrawl.blogPosts.length})</div>
    <div class="section-body">
      ${currentCrawl.blogPosts.length > 0 ? buildBlogTable(currentCrawl.blogPosts, hasPreviousData ? newBlogPosts.map((b) => b.url) : []) : '<p class="empty-state">No blog posts found.</p>'}
    </div>
  </div>

  <!-- Navigation -->
  <div class="section">
    <div class="section-header">Site Navigation</div>
    <div class="section-body">
      ${currentCrawl.navigation.length > 0 ? `<p>${currentCrawl.navigation.map(escapeHtml).join(" &bull; ")}</p>` : '<p class="empty-state">Navigation links not detected.</p>'}
    </div>
  </div>

</div>

<div class="footer">
  Generated by SBEK Crawler &middot; ${dateFormatted} at ${timeFormatted}
</div>

</body>
</html>`;
}

// ─── Section builders ────────────────────────────────────────────────────────

function buildProductChangesSection(
  newProducts: AnalysisResult["newProducts"],
  removedProducts: AnalysisResult["removedProducts"],
): string {
  if (newProducts.length === 0 && removedProducts.length === 0) {
    return `
  <div class="section">
    <div class="section-header">Product Changes</div>
    <div class="section-body">
      <p class="empty-state">No product changes detected since last crawl.</p>
    </div>
  </div>`;
  }

  let rows = "";
  for (const p of newProducts) {
    rows += `<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.price || "N/A")}</td>
      <td><span class="badge badge-new">NEW</span></td>
    </tr>`;
  }
  for (const p of removedProducts) {
    rows += `<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.price || "N/A")}</td>
      <td><span class="badge badge-removed">REMOVED</span></td>
    </tr>`;
  }

  return `
  <div class="section">
    <div class="section-header">Product Changes (${newProducts.length} new, ${removedProducts.length} removed)</div>
    <div class="section-body">
      <table>
        <thead><tr><th>Product</th><th>Price</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function buildPriceChangesSection(priceChanges: PriceChange[]): string {
  let rows = "";
  for (const pc of priceChanges) {
    const badge =
      pc.direction === "increase"
        ? '<span class="badge badge-increase">INCREASE</span>'
        : '<span class="badge badge-decrease">DECREASE</span>';
    rows += `<tr>
      <td>${escapeHtml(pc.productName)}</td>
      <td>${escapeHtml(pc.oldPrice)}</td>
      <td>${escapeHtml(pc.newPrice)}</td>
      <td>${pc.changePercent > 0 ? "+" : ""}${pc.changePercent}%</td>
      <td>${badge}</td>
    </tr>`;
  }

  return `
  <div class="section">
    <div class="section-header">Price Changes (&gt;10%) &mdash; ${priceChanges.length} detected</div>
    <div class="section-body">
      <table>
        <thead><tr><th>Product</th><th>Old Price</th><th>New Price</th><th>Change</th><th>Direction</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function buildProductsTable(
  products: Array<{ name: string; price: string; url: string }>,
): string {
  const displayProducts = products.slice(0, 100); // Cap display at 100
  let rows = "";
  for (const p of displayProducts) {
    const nameCell = p.url
      ? `<a class="product-link" href="${escapeAttr(p.url)}" target="_blank">${escapeHtml(p.name)}</a>`
      : escapeHtml(p.name);
    rows += `<tr><td>${nameCell}</td><td>${escapeHtml(p.price || "N/A")}</td></tr>`;
  }

  const overflow =
    products.length > 100
      ? `<p style="margin-top:0.5rem;font-size:0.85rem;color:#6c757d;">Showing 100 of ${products.length} products.</p>`
      : "";

  return `<table>
    <thead><tr><th>Product Name</th><th>Price</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>${overflow}`;
}

function buildBlogTable(
  posts: Array<{ title: string; url: string; date?: string }>,
  newPostUrls: string[],
): string {
  let rows = "";
  for (const post of posts) {
    const isNew = newPostUrls.includes(post.url);
    const badge = isNew
      ? ' <span class="badge badge-new">NEW</span>'
      : "";
    rows += `<tr>
      <td><a class="product-link" href="${escapeAttr(post.url)}" target="_blank">${escapeHtml(post.title)}</a>${badge}</td>
      <td>${escapeHtml(post.date || "N/A")}</td>
    </tr>`;
  }

  return `<table>
    <thead><tr><th>Title</th><th>Date</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

function seoCheckItem(label: string, passes: boolean): string {
  const cls = passes ? "pass" : "fail";
  const icon = passes ? "&#10003;" : "&#10007;";
  return `<div class="seo-item"><div class="seo-check ${cls}">${icon}</div>${escapeHtml(label)}</div>`;
}

function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${delta}`;
  return "0";
}

function freshnessClass(score: number): string {
  if (score >= 70) return "positive";
  if (score < 40) return "negative";
  return "";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
