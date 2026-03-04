import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { openai } from '../services/openai.service.js';
import { woocommerce } from '../services/woocommerce.service.js';
import { sheets } from '../services/googlesheets.service.js';
import type { ContentGenerationPayload } from '../queues/types.js';

/**
 * Content Pipeline Workflow
 *
 * Triggered by: content-generation queue worker
 *
 * Routes to the appropriate content generator based on payload.type:
 * - seo_meta       → SEO title & description → WooCommerce update → Sheets log
 * - faq            → FAQ JSON-LD → WooCommerce custom field → Sheets log
 * - aeo_kb         → Brand knowledge-base document → published as WooCommerce page
 * - comparison     → Comparison article → published as WooCommerce post
 * - schema_inject  → Product + Organization JSON-LD → WooCommerce meta field
 * - internal_links → Related product links → appended to product description
 */
export async function processContentGeneration(
  payload: ContentGenerationPayload,
): Promise<void> {
  const { productId, productName, type } = payload;

  logger.info({ productId, productName, type }, 'Starting content generation workflow');

  // Ensure Google Sheets is initialised
  await sheets.init();

  try {
    switch (type) {
      case 'seo_meta':
        await handleSEOMeta(productId, productName);
        break;

      case 'faq':
        await handleFAQ(productId, productName);
        break;

      case 'aeo_kb':
        await handleAEOKnowledgeBase(productId, productName);
        break;

      case 'comparison':
        await handleComparison(productId, productName);
        break;

      case 'schema_inject':
        await handleSchemaInjection(productId, productName);
        break;

      case 'internal_links':
        await handleInternalLinks(productId, productName);
        break;

      default:
        logger.warn({ type, productId }, 'Unknown content generation type');
    }
  } catch (err) {
    logger.error({ err, type, productId, productName }, `Content generation handler "${type}" failed`);
    throw err; // Re-throw so BullMQ records the failure
  }

  // Ping search engines to re-crawl sitemap after any content update
  await woocommerce.pingSitemap().catch((err) =>
    logger.warn({ err }, 'Non-critical: sitemap ping failed'),
  );

  logger.info({ productId, productName, type }, 'Content generation workflow completed');
}

// ── SEO Meta ──────────────────────────────────────────────────────────────

async function handleSEOMeta(productId: number, productName: string): Promise<void> {
  const product = await woocommerce.getProduct(productId);

  const category = product.categories.map((c) => c.name).join(', ') || 'Jewelry';
  const attributes = product.attributes
    .map((a) => `${a.name}: ${a.options.join(', ')}`)
    .join('; ');

  const meta = await openai.generateSEOMeta(productName, category, attributes);

  logger.info(
    { productId, title: meta.title, descriptionLength: meta.description.length },
    'SEO meta generated',
  );

  await woocommerce.updateProduct(productId, {
    meta_data: [
      { key: '_yoast_wpseo_title', value: meta.title },
      { key: '_yoast_wpseo_metadesc', value: meta.description },
    ],
  });

  logger.info({ productId }, 'WooCommerce product updated with SEO meta');

  await sheets.logEvent(
    'INFO',
    'content-pipeline',
    `SEO meta generated for "${productName}"`,
    JSON.stringify(meta),
  );
}

// ── FAQ ───────────────────────────────────────────────────────────────────

async function handleFAQ(productId: number, productName: string): Promise<void> {
  const product = await woocommerce.getProduct(productId);

  const category = product.categories.map((c) => c.name).join(', ') || 'Jewelry';
  const description = product.description || product.short_description || '';

  const faqs = await openai.generateFAQs(productName, category, description);

  if (faqs.length === 0) {
    logger.warn({ productId }, 'No FAQs generated — skipping update');
    return;
  }

  logger.info({ productId, faqCount: faqs.length }, 'FAQs generated');

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };

  await woocommerce.updateProduct(productId, {
    meta_data: [
      { key: '_sbek_faq_json_ld', value: JSON.stringify(faqJsonLd) },
      { key: '_sbek_faqs', value: JSON.stringify(faqs) },
    ],
  });

  logger.info({ productId }, 'WooCommerce product updated with FAQ JSON-LD');

  await sheets.logEvent(
    'INFO',
    'content-pipeline',
    `FAQs generated for "${productName}" (${faqs.length} items)`,
    JSON.stringify(faqs),
  );
}

// ── Schema Injection ─────────────────────────────────────────────────────

/**
 * Generate and inject full Product + Organization JSON-LD schema markup
 * into a WooCommerce product's custom field. Themes should output
 * the _sbek_schema_json_ld field inside a <script type="application/ld+json"> tag.
 */
async function handleSchemaInjection(productId: number, productName: string): Promise<void> {
  const product = await woocommerce.getProduct(productId);
  const brandUrl = env.BRAND_WEBSITE || env.WOO_URL || '';

  // Build Product schema
  const productSchema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: (product.short_description || product.description || '').replace(/<[^>]*>/g, ''),
    sku: product.sku || undefined,
    image: product.images.map((img) => img.src),
    brand: {
      '@type': 'Brand',
      name: env.BRAND_NAME || 'SBEK',
    },
    manufacturer: {
      '@type': 'Organization',
      name: env.BRAND_NAME || 'SBEK',
      url: brandUrl,
    },
    offers: {
      '@type': 'Offer',
      url: `${brandUrl}/product/${product.slug}/`,
      priceCurrency: 'INR',
      price: product.price || product.regular_price || '',
      availability: product.stock_status === 'instock'
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      seller: {
        '@type': 'Organization',
        name: env.BRAND_NAME || 'SBEK',
      },
    },
    category: product.categories.map((c) => c.name).join(' > '),
    material: product.attributes.find((a) => a.name.toLowerCase().includes('metal'))?.options.join(', ') || undefined,
  };

  // Build Organization schema
  const orgSchema = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: env.BRAND_NAME || 'SBEK',
    url: brandUrl,
    logo: product.images?.[0]?.src || '',
    contactPoint: {
      '@type': 'ContactPoint',
      telephone: env.BRAND_SUPPORT_PHONE || '',
      email: env.BRAND_SUPPORT_EMAIL || '',
      contactType: 'customer service',
    },
    sameAs: [],
  };

  // Combine both schemas
  const combinedSchema = JSON.stringify([productSchema, orgSchema]);

  await woocommerce.updateProduct(productId, {
    meta_data: [
      { key: '_sbek_schema_json_ld', value: combinedSchema },
    ],
  });

  logger.info({ productId }, 'Product + Organization JSON-LD schema injected');

  await sheets.logEvent(
    'INFO',
    'content-pipeline',
    `Schema JSON-LD injected for "${productName}"`,
    `Product schema + Organization schema (${combinedSchema.length} chars)`,
  );
}

// ── Internal Linking ─────────────────────────────────────────────────────

/**
 * Find related products in the same category and append internal links
 * to the product description. Also adds cross-links to collections.
 */
async function handleInternalLinks(productId: number, productName: string): Promise<void> {
  const product = await woocommerce.getProduct(productId);
  const brandUrl = env.BRAND_WEBSITE || env.WOO_URL || '';

  // Get related products from the same category
  const related = await woocommerce.getRelatedProducts(productId, 5);

  if (related.length === 0) {
    logger.info({ productId }, 'No related products found for internal linking');
    return;
  }

  // Build the "You May Also Like" HTML section
  const linksHtml = related
    .map((r) => `<li><a href="${r.link}" title="${r.name}">${r.name}</a></li>`)
    .join('\n');

  const categoryLinks = product.categories
    .map((c) => `<a href="${brandUrl}/product-category/${c.slug}/">${c.name}</a>`)
    .join(' | ');

  const internalLinksSection = `
<div class="sbek-related-products" style="margin-top:2em;padding-top:1em;border-top:1px solid #eee;">
<h3>You May Also Like</h3>
<ul>
${linksHtml}
</ul>
<p>Browse more: ${categoryLinks}</p>
</div>`;

  // Check if internal links section already exists
  const currentDesc = product.description || '';
  if (currentDesc.includes('sbek-related-products')) {
    // Replace existing section
    const updatedDesc = currentDesc.replace(
      /<div class="sbek-related-products"[\s\S]*?<\/div>/,
      internalLinksSection,
    );
    await woocommerce.updateProduct(productId, { description: updatedDesc });
  } else {
    // Append section
    await woocommerce.updateProduct(productId, {
      description: currentDesc + internalLinksSection,
    });
  }

  logger.info({ productId, relatedCount: related.length }, 'Internal links added to product');

  await sheets.logEvent(
    'INFO',
    'content-pipeline',
    `Internal links added for "${productName}" (${related.length} related products)`,
    related.map((r) => r.name).join(', '),
  );
}

// ── AEO Knowledge Base ───────────────────────────────────────────────────

/**
 * Generate AEO knowledge-base content and publish it as a WordPress page.
 * The page is published at /brand-knowledge/{product-slug}/ for AI crawlers.
 */
async function handleAEOKnowledgeBase(_productId: number, productName: string): Promise<void> {
  const systemPrompt = [
    'You are a brand content strategist for SBEK, a luxury Indian jewelry brand.',
    'Create a comprehensive knowledge-base article optimised for Answer Engine',
    'Optimization (AEO). This content will be used by AI assistants and featured',
    'snippets to answer user queries about the brand and its products.',
    '',
    'Structure (use HTML heading tags):',
    '- <h2>Brand Overview</h2> (who is SBEK, heritage, values)',
    '- <h2>Product Highlights</h2> and signature collections',
    '- <h2>Materials & Craftsmanship</h2> process',
    '- <h2>Customization</h2> and bespoke services',
    '- <h2>Pricing</h2> philosophy and value proposition',
    '- <h2>Customer Experience</h2> and after-sales care',
    '',
    'Write in HTML format with proper headings. Factual, authoritative tone.',
    'Include schema.org-friendly language. Output ONLY valid HTML content.',
  ].join('\n');

  const userPrompt = `Generate the AEO knowledge base document. Focus product: ${productName}`;

  const kbDocument = await openai.generateText(systemPrompt, userPrompt, {
    maxTokens: 2048,
    temperature: 0.5,
  });

  logger.info({ productName, length: kbDocument.length }, 'AEO knowledge base generated');

  // Publish as a WordPress page
  const slug = `brand-knowledge-${productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;

  try {
    const page = await woocommerce.upsertPage(
      slug,
      `${productName} — SBEK Knowledge Base`,
      kbDocument,
      'publish',
    );

    logger.info({ productName, pageId: page.id, link: page.link }, 'AEO KB published as WordPress page');

    await sheets.logEvent(
      'INFO',
      'content-pipeline',
      `AEO KB published for "${productName}"`,
      `Page: ${page.link}`,
    );
  } catch (err) {
    logger.error({ err, productName }, 'Failed to publish AEO KB page — logging content to Sheets');
    await sheets.logEvent(
      'WARN',
      'content-pipeline',
      `AEO KB generated but not published for "${productName}"`,
      kbDocument.slice(0, 500),
    );
  }
}

// ── Comparison Article ───────────────────────────────────────────────────

/**
 * Generate comparison article and publish it as a WordPress blog post.
 */
async function handleComparison(_productId: number, productName: string): Promise<void> {
  const systemPrompt = [
    'You are a content writer for SBEK, a luxury Indian jewelry brand.',
    'Write a comparison article that positions SBEK favourably against',
    'common alternatives in the market.',
    '',
    'Guidelines:',
    '- Be fair and factual — avoid disparaging competitors directly.',
    '- Highlight SBEK\'s unique strengths: handcrafted quality, Indian heritage,',
    '  customization options, transparent pricing.',
    '- Include a comparison table in HTML format.',
    '- Optimise for SEO with relevant long-tail keywords.',
    '- 800-1200 words.',
    '- Output in HTML format with proper headings.',
  ].join('\n');

  const userPrompt = `Write a comparison article for: ${productName}`;

  const article = await openai.generateText(systemPrompt, userPrompt, {
    maxTokens: 2048,
    temperature: 0.6,
  });

  logger.info({ productName, length: article.length }, 'Comparison article generated');

  // Publish as a WordPress blog post
  try {
    const post = await woocommerce.createPost(
      `${productName} — How SBEK Compares`,
      article,
      'publish',
    );

    logger.info({ productName, postId: post.id, link: post.link }, 'Comparison article published');

    await sheets.logEvent(
      'INFO',
      'content-pipeline',
      `Comparison article published for "${productName}"`,
      `Post: ${post.link}`,
    );
  } catch (err) {
    logger.error({ err, productName }, 'Failed to publish comparison article — logging to Sheets');
    await sheets.logEvent(
      'WARN',
      'content-pipeline',
      `Comparison article generated but not published for "${productName}"`,
      article.slice(0, 500),
    );
  }
}
