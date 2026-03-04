import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { settings } from './settings.service.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type AspectRatio = '1:1' | '9:16' | '16:9' | '4:3' | '3:4';
export type ImageSize = '0.5K' | '1K' | '2K' | '4K';

export interface NanoBananaOptions {
  /** Aspect ratio of the generated image. Default: '1:1' */
  aspectRatio?: AspectRatio;
  /** Output image size. Default: '2K' */
  imageSize?: ImageSize;
  /** Optional reference image as a base64-encoded string (no data-URI prefix). */
  referenceImageBase64?: string;
  /** MIME type for the reference image. Default: 'image/jpeg' */
  referenceImageMimeType?: string;
}

export interface GeneratedImage {
  /** Raw image data as a Buffer */
  buffer: Buffer;
  /** MIME type of the generated image (e.g. 'image/png') */
  mimeType: string;
  /** Absolute path if saved to disk, otherwise empty */
  filePath: string;
}

// ── Service ────────────────────────────────────────────────────────────────

class NanoBananaService {
  /**
   * OpenRouter image generation model.
   * Uses Gemini 3 Pro Image Preview (Nano Banana Pro) — the most advanced
   * image model on OpenRouter with best multimodal quality.
   */
  private readonly imageModel = 'google/gemini-3-pro-image-preview';
  private readonly outputDir: string;

  constructor() {
    this.outputDir = join(process.cwd(), 'creatives', 'generated');
  }

  /**
   * Refresh the API key from settings/env.
   */
  private async getApiKey(): Promise<string> {
    return (await settings.get('OPENROUTER_API_KEY')) ?? env.OPENROUTER_API_KEY ?? '';
  }

  /**
   * Generate an image using OpenRouter's chat completions endpoint
   * with modalities: ["image", "text"] and image_config.
   *
   * This is the correct OpenRouter image generation API — NOT images.generate.
   */
  async generateImage(
    prompt: string,
    options: NanoBananaOptions = {},
  ): Promise<GeneratedImage> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Image generation: OPENROUTER_API_KEY is not configured. Set it via Settings or .env');
    }

    const {
      aspectRatio = '1:1',
      imageSize = '2K',
      referenceImageBase64,
      referenceImageMimeType = 'image/jpeg',
    } = options;

    logger.info(
      { prompt: prompt.slice(0, 120), model: this.imageModel, aspectRatio, imageSize },
      'OpenRouter image generation starting',
    );

    // Build messages — with optional reference image for style-transfer
    const messages: Array<Record<string, unknown>> = [];

    if (referenceImageBase64) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${referenceImageMimeType};base64,${referenceImageBase64}`,
            },
          },
          {
            type: 'text',
            text: `Generate a new product image based on this reference. ${prompt}`,
          },
        ],
      });
    } else {
      messages.push({
        role: 'user',
        content: prompt,
      });
    }

    // OpenRouter image generation uses chat completions with modalities + image_config
    const body = {
      model: this.imageModel,
      messages,
      modalities: ['image', 'text'],
      image_config: {
        aspect_ratio: aspectRatio,
        image_size: imageSize,
      },
    };

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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

    if (!message) {
      throw new Error('OpenRouter image generation: empty response — no choices returned');
    }

    // Method 1: Images in message.images array (standard OpenRouter format)
    if (message.images && Array.isArray(message.images) && message.images.length > 0) {
      const imageUrl: string = message.images[0]?.image_url?.url ?? '';
      const extracted = this.extractBase64Image(imageUrl);
      if (extracted) {
        logger.info(
          { mimeType: extracted.mimeType, sizeKb: Math.round(extracted.buffer.length / 1024) },
          'Image generated via OpenRouter (images array)',
        );
        return { ...extracted, filePath: '' };
      }
    }

    // Method 2: Image inline in content as data URI
    const content: string = message.content ?? '';
    const dataUriMatch = content.match(/data:image\/(\w+);base64,([A-Za-z0-9+/=]+)/);
    if (dataUriMatch) {
      const mimeType = `image/${dataUriMatch[1]}`;
      const buffer = Buffer.from(dataUriMatch[2], 'base64');
      logger.info(
        { mimeType, sizeKb: Math.round(buffer.length / 1024) },
        'Image generated via OpenRouter (inline data URI)',
      );
      return { buffer, mimeType, filePath: '' };
    }

    // Method 3: Content parts with image_url type
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          const extracted = this.extractBase64Image(part.image_url.url);
          if (extracted) {
            logger.info(
              { mimeType: extracted.mimeType, sizeKb: Math.round(extracted.buffer.length / 1024) },
              'Image generated via OpenRouter (content parts)',
            );
            return { ...extracted, filePath: '' };
          }
        }
      }
    }

    throw new Error(
      'Image generation: no image data in OpenRouter response. Content: ' +
        (typeof content === 'string' ? content.slice(0, 300) : JSON.stringify(content).slice(0, 300)),
    );
  }

  /**
   * Extract base64 image data from a data URI string.
   */
  private extractBase64Image(dataUri: string): { buffer: Buffer; mimeType: string } | null {
    if (!dataUri || !dataUri.startsWith('data:image/')) return null;
    const match = dataUri.match(/^data:(image\/\w+);base64,(.+)$/s);
    if (!match) return null;
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64'),
    };
  }

  /**
   * Generate an image and save it to disk under creatives/generated/.
   * Returns the GeneratedImage with the filePath populated.
   */
  async generateAndSave(
    prompt: string,
    filename: string,
    options: NanoBananaOptions = {},
  ): Promise<GeneratedImage> {
    const result = await this.generateImage(prompt, options);

    const ext = result.mimeType.split('/')[1] ?? 'png';
    const finalFilename = filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
    const filePath = join(this.outputDir, finalFilename);

    await mkdir(this.outputDir, { recursive: true });
    await writeFile(filePath, result.buffer);

    logger.info({ filePath, sizeKb: Math.round(result.buffer.length / 1024) }, 'Creative image saved');

    return { ...result, filePath };
  }
}

// ── Singleton Export ──────────────────────────────────────────────────────────

export const nanobanana = new NanoBananaService();
