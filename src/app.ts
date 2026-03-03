import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { requestLogger } from './api/middleware/requestLogger.js';
import { errorHandler } from './api/middleware/errorHandler.js';
import { router } from './api/routes/index.js';

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

  // All routes
  app.use(router);

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}
