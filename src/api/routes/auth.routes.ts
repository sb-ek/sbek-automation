/**
 * Google OAuth2 routes for connecting the user's Google account
 * to Google Sheets and Google Drive.
 */

import { Router, Request } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { settings } from '../../services/settings.service.js';

export const authRouter = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
];

/**
 * Derive the public-facing origin from the request so the redirect URI
 * works both locally (http://localhost:3000) and in production behind
 * a reverse proxy (Railway, Nginx, etc.).
 */
function getOrigin(req: Request): string {
  // Explicit env var always wins
  if (process.env.GOOGLE_OAUTH_REDIRECT_URI) {
    return process.env.GOOGLE_OAUTH_REDIRECT_URI.replace(/\/auth\/google\/callback$/, '');
  }

  // Behind a proxy: respect X-Forwarded-* headers
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'http';
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? `localhost:${env.PORT ?? 3000}`;
  return `${proto}://${host}`;
}

async function getOAuth2Client(req: Request): Promise<OAuth2Client> {
  const clientId = (await settings.get('GOOGLE_OAUTH_CLIENT_ID')) ?? env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = (await settings.get('GOOGLE_OAUTH_CLIENT_SECRET')) ?? env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth client credentials not configured');
  }

  const origin = getOrigin(req);
  const redirectUri = `${origin}/auth/google/callback`;

  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /auth/google/authorize
 * Redirects the user to Google's OAuth consent screen.
 */
authRouter.get('/google/authorize', async (req, res) => {
  try {
    const client = await getOAuth2Client(req);
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
    });
    res.redirect(url);
  } catch (error) {
    logger.error({ err: error }, 'Failed to generate Google OAuth URL');
    res.status(500).json({
      error:
        'Google OAuth client credentials not configured. ' +
        'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Settings first.',
    });
  }
});

/**
 * GET /auth/google/callback
 * Handles the OAuth callback from Google, exchanges the code for tokens,
 * and stores the refresh token in the database.
 */
authRouter.get('/google/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    const client = await getOAuth2Client(req);
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      return res.status(400).json({
        error:
          'No refresh token received. Try revoking app access in your Google Account and reconnecting.',
      });
    }

    // Store the refresh token
    await settings.set('GOOGLE_OAUTH_REFRESH_TOKEN', tokens.refresh_token);

    // Fetch the connected email for display purposes
    client.setCredentials(tokens);
    const userInfo = await client.request<{ email: string }>({
      url: 'https://www.googleapis.com/oauth2/v2/userinfo',
    });
    const email = userInfo.data?.email ?? '';
    if (email) {
      await settings.set('GOOGLE_OAUTH_EMAIL', email);
    }

    logger.info({ email }, 'Google OAuth connected successfully');

    // Redirect back to dashboard settings — derive from Referer or env
    const dashboardUrl =
      process.env.DASHBOARD_URL ??
      (req.headers.referer ? new URL(req.headers.referer).origin : null) ??
      'http://localhost:3001';
    res.redirect(`${dashboardUrl}/settings?google=connected`);
  } catch (error) {
    logger.error({ err: error }, 'Google OAuth callback failed');
    res.status(500).json({ error: 'Failed to exchange authorization code' });
  }
});

/**
 * GET /auth/google/status
 * Returns the current Google OAuth connection status.
 */
authRouter.get('/google/status', async (_req, res) => {
  try {
    const refreshToken = await settings.get('GOOGLE_OAUTH_REFRESH_TOKEN');
    let email = await settings.get('GOOGLE_OAUTH_EMAIL');

    // Fallback: extract email from EMAIL_FROM (e.g. "SBEK <reserve@sbek.in>" → "reserve@sbek.in")
    if (!email && refreshToken) {
      const emailFrom = await settings.get('EMAIL_FROM');
      if (emailFrom) {
        const match = emailFrom.match(/<(.+?)>/);
        email = match ? match[1] : emailFrom;
      }
    }

    res.json({
      connected: !!refreshToken,
      email: email ?? '',
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to check Google OAuth status');
    res.json({ connected: false, email: '' });
  }
});

/**
 * POST /auth/google/disconnect
 * Removes the stored OAuth tokens, reverting to service account auth.
 */
authRouter.post('/google/disconnect', async (_req, res) => {
  try {
    await settings.set('GOOGLE_OAUTH_REFRESH_TOKEN', null);
    await settings.set('GOOGLE_OAUTH_EMAIL', null);

    logger.info('Google OAuth disconnected');
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to disconnect Google OAuth');
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});
