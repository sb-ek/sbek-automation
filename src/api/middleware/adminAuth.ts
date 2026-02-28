import type { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env.js';

/**
 * Basic-auth middleware for admin-only routes.
 * Uses ADMIN_USERNAME / ADMIN_PASSWORD from environment.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="SBEK Admin"');
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const base64 = authHeader.slice(6);
  const decoded = Buffer.from(base64, 'base64').toString('utf-8');
  const [username, password] = decoded.split(':');

  if (username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD) {
    next();
  } else {
    res.status(403).json({ error: 'Invalid credentials' });
  }
}
