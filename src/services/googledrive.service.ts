/**
 * Google Drive service for uploading creative assets.
 *
 * Uses the googleapis package (already a dependency) with the same
 * service-account credentials used for Google Sheets.
 */

import { google } from 'googleapis';
import { JWT, OAuth2Client } from 'google-auth-library';
import { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { settings } from './settings.service.js';

class GoogleDriveService {
  private drive: ReturnType<typeof google.drive> | null = null;
  private folderId: string | null = null;
  private initialized = false;
  /** Hash of the credentials used for the current connection */
  private credHash = '';

  /**
   * Authenticate with Google via OAuth2 (preferred) or service-account JWT
   * (fallback) and initialise the Drive client. Ensures the "SBEK Creatives"
   * folder exists. Re-initializes if credentials are updated via Settings.
   */
  async init(): Promise<void> {
    const serviceEmail = (await settings.get('GOOGLE_SERVICE_ACCOUNT_EMAIL')) ?? env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = (await settings.get('GOOGLE_PRIVATE_KEY')) ?? env.GOOGLE_PRIVATE_KEY;

    let auth: JWT | OAuth2Client;
    let hash: string;

    if (serviceEmail && privateKey) {
      // Service account JWT — preferred for Drive (has explicit drive.file scope)
      hash = serviceEmail;

      if (this.initialized && hash === this.credHash) return;

      auth = new JWT({
        email: serviceEmail,
        key: privateKey.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/drive'],
      });
      logger.info('Google Drive: using service account JWT authentication');
    } else {
      // OAuth2 fallback — only works if token has drive.file scope (dashboard OAuth flow)
      const refreshToken = (await settings.get('GOOGLE_OAUTH_REFRESH_TOKEN')) ?? env.GOOGLE_OAUTH_REFRESH_TOKEN;
      const clientId = (await settings.get('GOOGLE_OAUTH_CLIENT_ID')) ?? env.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = (await settings.get('GOOGLE_OAUTH_CLIENT_SECRET')) ?? env.GOOGLE_OAUTH_CLIENT_SECRET;

      if (!refreshToken) {
        throw new Error('No Google credentials configured — set service account or connect via OAuth');
      }

      hash = `oauth|${clientId ?? ''}`;

      if (this.initialized && hash === this.credHash) return;

      const oauth2 = new OAuth2Client(clientId, clientSecret);
      oauth2.setCredentials({ refresh_token: refreshToken });
      auth = oauth2;
      logger.info('Google Drive: using OAuth2 authentication');
    }

    try {
      this.drive = google.drive({ version: 'v3', auth });

      // Use explicit folder ID if provided, otherwise auto-create "SBEK Creatives"
      const explicitFolderId = (await settings.get('GOOGLE_DRIVE_FOLDER_ID')) ?? env.GOOGLE_DRIVE_FOLDER_ID;
      this.folderId = explicitFolderId || await this.ensureFolder('SBEK Creatives');

      this.initialized = true;
      this.credHash = hash;
      logger.info({ folderId: this.folderId }, 'Google Drive service initialised');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialise Google Drive service');
      throw error;
    }
  }

  /**
   * Find or create a folder by name. Returns the folder ID.
   */
  private async ensureFolder(name: string): Promise<string> {
    if (!this.drive) throw new Error('Drive not initialised');

    // Search for existing folder
    const search = await this.drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    if (search.data.files && search.data.files.length > 0) {
      return search.data.files[0].id!;
    }

    // Create folder
    const folder = await this.drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });

    const id = folder.data.id!;

    // Share the folder with the brand owner so it appears in their Drive
    const ownerEmail = env.BRAND_OWNER_EMAIL || env.SMTP_USER;
    if (ownerEmail) {
      try {
        await this.drive!.permissions.create({
          fileId: id,
          requestBody: { role: 'writer', type: 'user', emailAddress: ownerEmail },
          sendNotificationEmail: false,
        });
        logger.info({ folderId: id, sharedWith: ownerEmail }, 'Drive folder shared with owner');
      } catch (_err) {
        logger.warn({ folderId: id }, 'Could not share folder with owner — check email');
      }
    }

    logger.info({ folderId: id, name }, 'Google Drive folder created');
    return id;
  }

  /**
   * Upload a file buffer to the SBEK Creatives folder on Google Drive.
   * Returns the file's web view link and ID.
   */
  async uploadFile(
    buffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<{ fileId: string; webViewLink: string; webContentLink: string }> {
    if (!this.initialized) await this.init();
    if (!this.drive || !this.folderId) {
      throw new Error('Google Drive service not available');
    }

    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    const response = await this.drive.files.create({
      requestBody: {
        name: filename,
        parents: [this.folderId],
      },
      media: {
        mimeType,
        body: stream,
      },
      fields: 'id, webViewLink, webContentLink',
    }, { timeout: 30_000 });

    const fileId = response.data.id!;
    const webViewLink = response.data.webViewLink || '';
    const webContentLink = response.data.webContentLink || '';

    // Make the file accessible via link (anyone with link can view)
    await this.drive.permissions.create({
      fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    logger.info(
      { fileId, filename, sizeKb: Math.round(buffer.length / 1024) },
      'File uploaded to Google Drive',
    );

    return { fileId, webViewLink, webContentLink };
  }
}

// ── Singleton Export ────────────────────────────────────────────────────────

export const gdrive = new GoogleDriveService();
