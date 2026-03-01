/**
 * Google Drive service for uploading creative assets.
 *
 * Uses the googleapis package (already a dependency) with the same
 * service-account credentials used for Google Sheets.
 */

import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

class GoogleDriveService {
  private drive: ReturnType<typeof google.drive> | null = null;
  private folderId: string | null = null;
  private initialized = false;

  /**
   * Authenticate with Google via service-account JWT and initialise
   * the Drive client. Ensures the "SBEK Creatives" folder exists.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const auth = new JWT({
        email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: (env.GOOGLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/drive.file'],
      });

      this.drive = google.drive({ version: 'v3', auth });

      // Ensure the shared creatives folder exists
      this.folderId = await this.ensureFolder('SBEK Creatives');

      this.initialized = true;
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
    });

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
