import { logger } from '../config/logger.js';
import { nanobanana, type AspectRatio } from '../services/nanobanana.service.js';
import { openai } from '../services/openai.service.js';
import { sheets } from '../services/googlesheets.service.js';
import type { CreativeGenerationPayload } from '../queues/types.js';

// ── Variant Prompt Builders ──────────────────────────────────────────────────

const VARIANT_PROMPTS: Record<string, (name: string, desc: string) => string> = {
  white_bg: (name, desc) =>
    `Professional jewelry product photo of ${name} on a pure white background. ` +
    `${desc}. Studio lighting with soft shadows, high-end e-commerce style, ` +
    `sharp focus on intricate details, 4K product photography.`,

  lifestyle: (name, desc) =>
    `Elegant Indian woman wearing ${name} at a luxury event. ` +
    `${desc}. Soft golden-hour lighting, shallow depth of field, ` +
    `rich silk saree complement, candid yet editorial feel, warm tones.`,

  festive: (name, desc) =>
    `Beautiful ${name} with Diwali diyas and marigold flowers in the background. ` +
    `${desc}. Festive Indian celebration atmosphere, warm golden lighting, ` +
    `traditional brass plate, rose petals scattered, rich and vibrant colors.`,

  minimal_text: (name, desc) =>
    `${name} centered on minimal cream background with ample negative space. ` +
    `${desc}. Clean, modern luxury aesthetic, subtle shadow, ` +
    `ready for text overlay, magazine-quality editorial layout.`,

  story_format: (name, desc) =>
    `Vertical 9:16 format, ${name} close-up macro photography. ` +
    `${desc}. Dramatic studio lighting highlighting gemstone facets ` +
    `and metal texture, ultra-sharp detail, dark moody background, cinematic feel.`,
};

// ── Variant → Aspect Ratio Mapping ───────────────────────────────────────────

const VARIANT_ASPECT: Record<string, AspectRatio> = {
  white_bg: '1:1',
  lifestyle: '1:1',
  festive: '1:1',
  minimal_text: '1:1',
  story_format: '9:16',
};

// ── Workflow ─────────────────────────────────────────────────────────────────

/**
 * Creative Pipeline Workflow
 *
 * Triggered by: creative-generation queue worker
 *
 * For each requested variant:
 * 1. Build a prompt from the product info and variant type
 * 2. Generate the image via Nano Banana (Gemini image generation)
 * 3. Save the image to disk and log to the Creatives tab in Google Sheets
 *
 * After all variants, generate an Instagram caption for the product.
 * Returns an array of saved file paths.
 */
export async function processCreativeGeneration(
  payload: CreativeGenerationPayload,
): Promise<string[]> {
  const { productId, productName, productDescription, productImageUrl, category, variants } = payload;

  logger.info(
    { productId, productName, variantCount: variants.length },
    'Starting creative generation workflow (Nano Banana)',
  );

  const filePaths: string[] = [];
  const now = new Date().toISOString();

  // Fetch the product reference image if available (for style-transfer)
  let referenceImageBase64: string | undefined;
  if (productImageUrl) {
    try {
      const imgRes = await fetch(productImageUrl);
      if (imgRes.ok) {
        const arrayBuf = await imgRes.arrayBuffer();
        referenceImageBase64 = Buffer.from(arrayBuf).toString('base64');
      }
    } catch (err) {
      logger.warn({ err, productImageUrl }, 'Could not fetch product reference image — generating without it');
    }
  }

  // Generate an image for each requested variant
  for (const variant of variants) {
    const promptBuilder = VARIANT_PROMPTS[variant];

    if (!promptBuilder) {
      logger.warn({ variant, productId }, 'Unknown creative variant — skipping');
      continue;
    }

    const prompt = promptBuilder(productName, productDescription);
    const aspectRatio = VARIANT_ASPECT[variant] ?? '1:1';
    const filename = `product-${productId}-${variant}-${Date.now()}`;

    try {
      const result = await nanobanana.generateAndSave(prompt, filename, {
        aspectRatio,
        imageSize: '2K',
        referenceImageBase64,
        referenceImageMimeType: 'image/jpeg',
      });

      filePaths.push(result.filePath);

      logger.info({ productId, variant, filePath: result.filePath }, 'Creative image generated via Nano Banana');

      // Log to Creatives tab in Sheets
      await sheets.appendCreative({
        'Product ID': String(productId),
        'Product Name': productName,
        'Variant': variant,
        'Creative Type': 'AI Generated (Nano Banana)',
        'Image URL': '',
        'Drive Link': result.filePath,
        'Generated Date': now,
        'Status': 'Generated',
        'Approved By': '',
        'Posted Date': '',
      });
    } catch (err) {
      logger.error(
        { err, productId, variant },
        'Failed to generate creative image — continuing with next variant',
      );
    }
  }

  // Generate an Instagram caption for the product
  try {
    const caption = await openai.generateCaption(productName, category, 'luxurious and aspirational');

    logger.info({ productId, captionLength: caption.length }, 'Instagram caption generated');

    // Log caption to System Logs for reference
    await sheets.logEvent(
      'INFO',
      'creative-pipeline',
      `Instagram caption generated for "${productName}"`,
      caption.slice(0, 500),
    );
  } catch (err) {
    logger.error({ err, productId }, 'Failed to generate Instagram caption');
  }

  logger.info(
    { productId, productName, generatedCount: filePaths.length, totalVariants: variants.length },
    'Creative generation workflow completed',
  );

  return filePaths;
}
