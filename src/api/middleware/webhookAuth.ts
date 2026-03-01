import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

// ---------------------------------------------------------------------------
// Extend the Express Request type so we can access the raw body buffer.
//
// IMPORTANT: Express must be configured to capture the raw body. Add this
// when you set up the JSON body parser:
//
//   app.use(
//     express.json({
//       verify: (req, _res, buf) => {
//         (req as Request & { rawBody?: Buffer }).rawBody = buf;
//       },
//     }),
//   );
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

// ---------------------------------------------------------------------------
// WooCommerce webhook HMAC-SHA256 signature verification middleware
// ---------------------------------------------------------------------------

/**
 * Verifies the `x-wc-webhook-signature` header sent by WooCommerce.
 *
 * WooCommerce signs webhook payloads with a base64-encoded HMAC-SHA256 digest
 * using the webhook secret configured in the store admin.
 */
export function webhookAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const signature = req.headers['x-wc-webhook-signature'];

  if (!signature || typeof signature !== 'string') {
    logger.warn('Webhook request missing x-wc-webhook-signature header');
    res.status(401).json({ error: true, message: 'Missing webhook signature' });
    return;
  }

  if (!req.rawBody) {
    logger.error(
      'rawBody is not available on the request — ensure express.json() is ' +
        'configured with the verify callback that captures the raw buffer',
    );
    res.status(500).json({ error: true, message: 'Server misconfiguration' });
    return;
  }

  const expected = createHmac('sha256', env.WOO_WEBHOOK_SECRET ?? '')
    .update(req.rawBody)
    .digest('base64');

  // Use timing-safe comparison to prevent timing attacks
  const signatureBuffer = Buffer.from(signature, 'base64');
  const expectedBuffer = Buffer.from(expected, 'base64');

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    logger.warn('Webhook signature verification failed');
    res.status(401).json({ error: true, message: 'Invalid webhook signature' });
    return;
  }

  next();
}
