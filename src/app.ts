import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { requestLogger } from './api/middleware/requestLogger.js';
import { errorHandler } from './api/middleware/errorHandler.js';
import { router } from './api/routes/index.js';

// --- Rate limiters ---

/** Global fallback: 100 req/min per IP */
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

/** Stricter limit for webhook endpoints: 30 req/min per IP */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many webhook requests, please try again later' },
});

/** Dashboard polls frequently — 200 req/min per IP */
export const dashboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many dashboard requests, please try again later' },
});

/**
 * Create and configure the Express application.
 * Separated from index.ts so it can be imported for testing.
 */
export function createApp() {
  const app = express();

  // Trust proxy (Railway, Vercel, etc. run behind reverse proxies)
  app.set('trust proxy', 1);

  // Security headers
  app.use(helmet());
  app.use(cors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  }));

  // Parse JSON bodies with raw body preservation for webhook signature verification
  app.use(
    express.json({
      limit: '5mb',
      verify: (req: express.Request, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  // Parse URL-encoded bodies (WooCommerce ping sends form data)
  app.use(express.urlencoded({ extended: true }));

  // Request logging (skips /health to reduce noise)
  app.use(requestLogger);

  // Global rate limit (100 req/min per IP)
  app.use(globalLimiter);

  // Route-specific rate limits (applied before route handlers)
  app.use('/webhooks', webhookLimiter);
  app.use('/dashboard', dashboardLimiter);

  // All routes
  app.use(router);

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}
