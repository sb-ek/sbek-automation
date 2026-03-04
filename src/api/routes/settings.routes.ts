import { Router, type Request, type Response } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { settings, CONFIGURABLE_KEYS, type ConfigurableKey } from '../../services/settings.service.js';
import { logger } from '../../config/logger.js';

export const settingsRouter = Router();
settingsRouter.use(apiLimiter);
settingsRouter.use(requireAdminAuth);

/**
 * GET /admin/settings
 * List all configurable keys, their status, and masked values.
 */
settingsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const list = await settings.list();
    res.json({
      settings: list,
      configurableKeys: CONFIGURABLE_KEYS,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to list settings');
    res.status(500).json({ error: 'Failed to list settings' });
  }
});

/**
 * PUT /admin/settings
 * Update one or more API keys / settings.
 *
 * Body: { "keys": { "OPENROUTER_API_KEY": "sk-or-v1-..." } }
 *
 * Pass `null` for a value to remove the DB override and fall back to the env var.
 */
settingsRouter.put('/', async (req: Request, res: Response) => {
  const { keys } = req.body as { keys?: Record<string, string | null> };

  if (!keys || typeof keys !== 'object') {
    res.status(400).json({ error: 'Body must contain a "keys" object' });
    return;
  }

  // Validate that all provided keys are configurable
  const invalidKeys = Object.keys(keys).filter(
    (k) => !(CONFIGURABLE_KEYS as readonly string[]).includes(k),
  );

  if (invalidKeys.length > 0) {
    res.status(400).json({
      error: `Invalid keys: ${invalidKeys.join(', ')}`,
      validKeys: CONFIGURABLE_KEYS,
    });
    return;
  }

  try {
    await settings.setMany(keys as Partial<Record<ConfigurableKey, string | null>>);

    const updated = Object.keys(keys);
    logger.info({ updated }, 'Admin updated settings');

    res.json({
      message: `Updated ${updated.length} setting(s)`,
      updated,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to update settings');
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * DELETE /admin/settings/:key
 * Remove a single DB override, reverting to the env var.
 */
settingsRouter.delete('/:key', async (req: Request, res: Response) => {
  const key = String(req.params.key);

  if (!(CONFIGURABLE_KEYS as readonly string[]).includes(key)) {
    res.status(400).json({ error: `Invalid key: ${key}` });
    return;
  }

  try {
    await settings.set(key as ConfigurableKey, null);
    res.json({ message: `Setting "${key}" removed — reverting to env variable` });
  } catch (err) {
    logger.error({ err, key }, 'Failed to delete setting');
    res.status(500).json({ error: 'Failed to delete setting' });
  }
});

/**
 * POST /admin/settings/refresh
 * Force-reload the in-memory cache from the database.
 */
settingsRouter.post('/refresh', async (_req: Request, res: Response) => {
  try {
    await settings.refresh();
    res.json({ message: 'Settings cache refreshed' });
  } catch (err) {
    logger.error({ err }, 'Failed to refresh settings');
    res.status(500).json({ error: 'Failed to refresh cache' });
  }
});
