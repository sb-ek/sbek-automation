import OpenAI from 'openai';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { settings } from './settings.service.js';

// ── Service ─────────────────────────────────────────────────────────────────

class OpenAIService {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }

  /** Re-initialize the OpenAI client with the latest API key from settings */
  async refreshClient(): Promise<void> {
    const key = await settings.get('OPENAI_API_KEY');
    if (key) {
      this.client = new OpenAI({ apiKey: key });
    }
  }

  // ── Generic Text Generation ────────────────────────────────────────────

  /**
   * Send a system + user prompt to GPT-4o and return the text content.
   */
  async generateText(
    systemPrompt: string,
    userPrompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: 'gpt-4o',
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
        promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens,
        totalTokens: completion.usage?.total_tokens,
      },
      'OpenAI text generation completed',
    );

    return content;
  }

  // ── Image Generation ───────────────────────────────────────────────────

  /**
   * Generate an image with DALL-E 3 and return its URL.
   */
  async generateImage(
    prompt: string,
    options?: {
      size?: '1024x1024' | '1024x1792' | '1792x1024';
      quality?: 'standard' | 'hd';
    },
  ): Promise<string> {
    const response = await this.client.images.generate({
      model: 'dall-e-3',
      prompt,
      size: options?.size ?? '1024x1024',
      quality: options?.quality ?? 'standard',
      n: 1,
    });

    const imageUrl = response.data?.[0]?.url ?? '';

    logger.info(
      { size: options?.size ?? '1024x1024', quality: options?.quality ?? 'standard' },
      'OpenAI image generation completed',
    );

    return imageUrl;
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
      const parsed = JSON.parse(raw) as { title: string; description: string };

      return {
        title: parsed.title.slice(0, 60),
        description: parsed.description.slice(0, 160),
      };
    } catch (err) {
      logger.error({ err, raw, productName }, 'Failed to parse SEO meta JSON from OpenAI');
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
      const parsed = JSON.parse(raw) as Array<{ question: string; answer: string }>;

      if (!Array.isArray(parsed)) {
        throw new Error('Expected an array of FAQ objects');
      }

      return parsed;
    } catch (err) {
      logger.error({ err, raw, productName }, 'Failed to parse FAQ JSON from OpenAI');
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
}

// ── Singleton Export ────────────────────────────────────────────────────────

export const openai = new OpenAIService();
