import OpenAI from 'openai';
import { db } from '../config/database.js';
import { systemConfig } from '../db/schema.js';
import { inArray } from 'drizzle-orm';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { settings } from './settings.service.js';

// ── Service ─────────────────────────────────────────────────────────────────

class AIService {
  private cachedKey: string | null = null;
  private cachedModel: string | null = null;
  private cachedImageModel: string | null = null;
  private cacheTime = 0;
  private readonly CACHE_TTL = 60_000; // 1 minute

  /**
   * Fetch the OpenRouter API key and model settings.
   * Priority: database override → settings service → env variable
   * Results are cached for CACHE_TTL milliseconds.
   */
  private async getConfig(): Promise<{ apiKey: string; model: string; imageModel: string }> {
    const now = Date.now();
    if (this.cachedKey && now - this.cacheTime < this.CACHE_TTL) {
      return {
        apiKey: this.cachedKey,
        model: this.cachedModel || 'google/gemini-2.5-flash',
        imageModel: this.cachedImageModel || 'google/gemini-3-pro-image-preview',
      };
    }

    try {
      const rows = await db
        .select()
        .from(systemConfig)
        .where(
          inArray(systemConfig.key, [
            'openrouter_api_key',
            'openrouter_model',
            'openrouter_image_model',
          ]),
        );

      for (const row of rows) {
        if (row.key === 'openrouter_api_key') {
          this.cachedKey = row.value as string;
        } else if (row.key === 'openrouter_model') {
          this.cachedModel = row.value as string;
        } else if (row.key === 'openrouter_image_model') {
          this.cachedImageModel = row.value as string;
        }
      }

      this.cacheTime = Date.now();
    } catch (err) {
      logger.warn({ err }, 'Failed to read AI config from system_config table, falling back to env');
    }

    // Also check the settings service (set via dashboard)
    if (!this.cachedKey) {
      const settingsKey = await settings.get('OPENROUTER_API_KEY');
      if (settingsKey) { this.cachedKey = settingsKey; }
    }

    // Final fallback to env var
    if (!this.cachedKey && env.OPENROUTER_API_KEY) {
      this.cachedKey = env.OPENROUTER_API_KEY;
    }

    return {
      apiKey: this.cachedKey || '',
      model: this.cachedModel || 'google/gemini-2.5-flash',
      imageModel: this.cachedImageModel || 'google/gemini-3-pro-image-preview',
    };
  }

  /**
   * Build an OpenAI-compatible client pointing to OpenRouter.
   */
  private async getClient(): Promise<OpenAI> {
    const config = await this.getConfig();

    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://sbek.com',
        'X-Title': 'SBEK Automation',
      },
    });
  }

  /** Invalidate cached config so the next request fetches fresh keys */
  async refreshClient(): Promise<void> {
    this.cacheTime = 0;
    this.cachedKey = null;
  }

  // ── Generic Text Generation ────────────────────────────────────────────

  /**
   * Send a system + user prompt to the configured model and return the text content.
   */
  async generateText(
    systemPrompt: string,
    userPrompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const config = await this.getConfig();
    const client = await this.getClient();

    logger.info({ model: config.model, provider: 'openrouter' }, 'Starting AI text generation');

    const completion = await client.chat.completions.create({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
    });

    const content = completion.choices[0]?.message?.content ?? '';

    logger.info(
      {
        model: config.model,
        provider: 'openrouter',
        promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens,
        totalTokens: completion.usage?.total_tokens,
      },
      'AI text generation completed',
    );

    return content;
  }

  // ── Image Generation ───────────────────────────────────────────────────

  /**
   * Generate an image via OpenRouter's chat completions endpoint with
   * modalities: ["image", "text"]. Returns the base64 data URI of the image.
   */
  async generateImage(
    prompt: string,
    options?: {
      aspectRatio?: string;
      imageSize?: string;
    },
  ): Promise<string> {
    const config = await this.getConfig();

    logger.info({ model: config.imageModel, provider: 'openrouter' }, 'Starting AI image generation');

    const body = {
      model: config.imageModel,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['image', 'text'],
      image_config: {
        aspect_ratio: options?.aspectRatio ?? '1:1',
        image_size: options?.imageSize ?? '2K',
      },
    };

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://sbek.com',
        'X-Title': 'SBEK Automation',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter image generation failed (${response.status}): ${errorText.slice(0, 500)}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();
    const message = data?.choices?.[0]?.message;

    // Extract image URL from response
    if (message?.images?.[0]?.image_url?.url) {
      return message.images[0].image_url.url;
    }

    // Fallback: inline data URI in content
    const content: string = message?.content ?? '';
    const match = content.match(/data:image\/\w+;base64,[A-Za-z0-9+/=]+/);
    if (match) return match[0];

    logger.warn({ content: content.slice(0, 200) }, 'No image found in OpenRouter response');
    return '';
  }

  // ── SEO Meta Generation ────────────────────────────────────────────────

  /**
   * Generate an SEO-optimised title and meta description for a product
   * from the SBEK luxury Indian jewelry brand.
   */
  async generateSEOMeta(
    productName: string,
    category: string,
    attributes: string,
  ): Promise<{ title: string; description: string }> {
    const systemPrompt = [
      'You are an expert SEO copywriter for SBEK, a luxury Indian jewelry brand.',
      'SBEK specializes in handcrafted gold, diamond, and gemstone jewelry with',
      'contemporary designs rooted in traditional Indian craftsmanship.',
      '',
      'Generate an SEO-optimised meta title and meta description for the product.',
      'Rules:',
      '- Title MUST be under 60 characters.',
      '- Description MUST be under 160 characters.',
      '- Include the brand name "SBEK" naturally.',
      '- Incorporate relevant keywords for the category and attributes.',
      '- Write in a tone that conveys luxury, elegance, and trust.',
      '',
      'Return ONLY valid JSON in this exact format:',
      '{ "title": "...", "description": "..." }',
    ].join('\n');

    const userPrompt = [
      `Product: ${productName}`,
      `Category: ${category}`,
      `Attributes: ${attributes}`,
    ].join('\n');

    const raw = await this.generateText(systemPrompt, userPrompt, {
      maxTokens: 256,
      temperature: 0.6,
    });

    try {
      // Strip markdown code fences if present (Gemini often wraps JSON in ```json...```)
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned) as { title: string; description: string };

      return {
        title: parsed.title.slice(0, 60),
        description: parsed.description.slice(0, 160),
      };
    } catch (err) {
      logger.error({ err, raw, productName }, 'Failed to parse SEO meta JSON from AI');
      return {
        title: `${productName} | SBEK Luxury Jewelry`.slice(0, 60),
        description: `Shop ${productName} from SBEK. Handcrafted luxury Indian jewelry.`.slice(0, 160),
      };
    }
  }

  // ── FAQ Generation ─────────────────────────────────────────────────────

  /**
   * Generate 5 frequently-asked-question pairs covering care, customization,
   * delivery, materials, and gifting for the given product.
   */
  async generateFAQs(
    productName: string,
    category: string,
    description: string,
  ): Promise<Array<{ question: string; answer: string }>> {
    const systemPrompt = [
      'You are a knowledgeable customer support specialist for SBEK,',
      'a luxury Indian jewelry brand known for handcrafted gold, diamond,',
      'and gemstone pieces.',
      '',
      'Generate exactly 5 FAQ pairs for the product. Cover these topics:',
      '1. Care & maintenance',
      '2. Customization options (sizing, engraving, metal choices)',
      '3. Delivery timeline & packaging',
      '4. Materials & craftsmanship',
      '5. Gifting & occasions',
      '',
      'Each answer should be 2-3 sentences, authoritative yet warm.',
      '',
      'Return ONLY valid JSON as an array:',
      '[{ "question": "...", "answer": "..." }, ...]',
    ].join('\n');

    const userPrompt = [
      `Product: ${productName}`,
      `Category: ${category}`,
      `Description: ${description}`,
    ].join('\n');

    const raw = await this.generateText(systemPrompt, userPrompt, {
      maxTokens: 1024,
      temperature: 0.6,
    });

    try {
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned) as Array<{ question: string; answer: string }>;

      if (!Array.isArray(parsed)) {
        throw new Error('Expected an array of FAQ objects');
      }

      return parsed;
    } catch (err) {
      logger.error({ err, raw, productName }, 'Failed to parse FAQ JSON from AI');
      return [];
    }
  }

  // ── Instagram Caption Generation ───────────────────────────────────────

  /**
   * Generate an Instagram caption with relevant hashtags for a product post.
   */
  async generateCaption(
    productName: string,
    category: string,
    tone: string,
  ): Promise<string> {
    const systemPrompt = [
      'You are a social media manager for SBEK, a luxury Indian jewelry brand.',
      'Write an engaging Instagram caption for a product post.',
      '',
      'Guidelines:',
      '- Match the requested tone.',
      '- Keep the caption between 100-200 words.',
      '- Include a compelling hook in the first line.',
      '- End with a clear call to action.',
      '- Add 10-15 relevant hashtags on a separate line at the end.',
      '- Mix branded (#SBEK #SBEKJewelry) and discovery hashtags.',
      '',
      'Return ONLY the caption text (no JSON wrapping).',
    ].join('\n');

    const userPrompt = [
      `Product: ${productName}`,
      `Category: ${category}`,
      `Tone: ${tone}`,
    ].join('\n');

    return this.generateText(systemPrompt, userPrompt, {
      maxTokens: 512,
      temperature: 0.8,
    });
  }

  // ── Competitor Analysis ────────────────────────────────────────────────

  /**
   * Given raw crawl data from a competitor, produce actionable insights
   * comparing their strategy against SBEK's positioning.
   */
  async analyzeCompetitor(
    competitorName: string,
    crawlData: Record<string, unknown>,
  ): Promise<string> {
    const systemPrompt = [
      'You are a competitive intelligence analyst for SBEK, a luxury Indian',
      'jewelry brand. Analyse the following competitor crawl data and produce',
      'actionable insights.',
      '',
      'Structure your analysis as:',
      '1. Pricing & Positioning — how do they compare to SBEK?',
      '2. Product Range — gaps or overlaps with SBEK?',
      '3. SEO & Content Strategy — keyword themes, content quality.',
      '4. Promotions & Offers — current campaigns or discounts.',
      '5. Recommendations — 3-5 specific actions SBEK should take.',
      '',
      'Be concise, data-driven, and specific. Reference numbers from the data.',
    ].join('\n');

    const userPrompt = [
      `Competitor: ${competitorName}`,
      `Crawl Data:\n${JSON.stringify(crawlData, null, 2)}`,
    ].join('\n');

    return this.generateText(systemPrompt, userPrompt, {
      maxTokens: 2048,
      temperature: 0.5,
    });
  }

  /**
   * Enhanced competitor analysis that includes:
   * - Historical delta comparison (if previous data available)
   * - Messaging & brand voice analysis
   * - Technical SEO assessment
   * - Trend detection over time
   */
  async analyzeCompetitorEnhanced(
    competitorName: string,
    currentData: Record<string, unknown>,
    previousData?: Record<string, unknown>,
  ): Promise<string> {
    const systemPrompt = [
      'You are a senior competitive intelligence analyst for SBEK, a luxury Indian',
      'jewelry brand. Perform a comprehensive competitor analysis.',
      '',
      'Structure your analysis into these sections:',
      '',
      '## 1. Pricing & Positioning',
      '- Price range analysis and comparison to SBEK',
      '- Value proposition positioning',
      '',
      '## 2. Product Range',
      '- Catalog size and gaps/overlaps with SBEK',
      '- New products or collections (if historical data available)',
      '',
      '## 3. SEO & Content Strategy',
      '- Meta description quality and keyword usage',
      '- H1 tag effectiveness',
      '- Structured data implementation (JSON-LD presence)',
      '- Content freshness and blog activity',
      '- Open Graph and social media optimization',
      '',
      '## 4. Technical SEO Assessment',
      '- Schema markup quality',
      '- Mobile optimization signals',
      '- Site architecture (navigation depth, URL structure)',
      '- Indexability signals',
      '',
      '## 5. Messaging & Brand Voice',
      '- Tone of copy (luxury vs mass-market, emotional vs rational)',
      '- Key messaging themes and value props',
      '- Target audience indicators',
      '- Call-to-action patterns',
      '- Cultural positioning (Indian heritage, global appeal)',
      '',
      '## 6. Historical Trends',
      previousData
        ? '- Compare current vs previous crawl for changes in products, pricing, content'
        : '- No previous data available. Baseline established.',
      '',
      '## 7. Recommendations',
      '- 3-5 specific, actionable recommendations for SBEK',
      '',
      'Be concise, data-driven, and specific. Reference actual numbers and content from the data.',
    ].join('\n');

    const dataSections = [`Competitor: ${competitorName}`];
    dataSections.push(`\nCurrent Crawl Data:\n${JSON.stringify(currentData, null, 2).slice(0, 6000)}`);

    if (previousData) {
      dataSections.push(`\nPrevious Crawl Data:\n${JSON.stringify(previousData, null, 2).slice(0, 3000)}`);
    }

    return this.generateText(systemPrompt, dataSections.join('\n'), {
      maxTokens: 3000,
      temperature: 0.5,
    });
  }

}

// ── Singleton Export ────────────────────────────────────────────────────────

export const openai = new AIService();
