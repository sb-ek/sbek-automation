import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

// ── Interfaces ──────────────────────────────────────────────────────

interface CreatePostData {
  content: string;
  mediaIds?: string[];
  platforms: string[];
  scheduledAt?: string;
}

// ── Service ─────────────────────────────────────────────────────────

class PostizService {
  /** Resolve the current base URL and headers from env */
  private async getConfig(): Promise<{ baseUrl: string; headers: Record<string, string> }> {
    const apiKey = env.POSTIZ_API_KEY ?? '';
    const baseUrl = env.POSTIZ_BASE_URL;
    return {
      baseUrl,
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
    };
  }

  // ── Public methods ───────────────────────────────────────────────

  /**
   * Upload media to Postiz by passing the image URL.
   * Postiz will download and host the image on its side.
   * Returns the media ID assigned by Postiz.
   */
  async uploadMedia(imageUrl: string, filename: string): Promise<string> {
    const body = {
      url: imageUrl,
      filename,
    };

    try {
      const data = await this.request('POST', '/media', body);
      const mediaId: string = data.id;
      logger.info({ mediaId, filename }, 'Media uploaded to Postiz');
      return mediaId;
    } catch (error) {
      logger.error({ error, imageUrl, filename }, 'Failed to upload media to Postiz');
      throw error;
    }
  }

  /**
   * Create a new social media post (or scheduled draft) in Postiz.
   * Returns the post ID.
   */
  async createPost(data: CreatePostData): Promise<string> {
    const body = {
      content: data.content,
      ...(data.mediaIds?.length && { media: data.mediaIds }),
      platforms: data.platforms,
      ...(data.scheduledAt && { scheduledAt: data.scheduledAt }),
    };

    try {
      const response = await this.request('POST', '/posts', body);
      const postId: string = response.id;
      logger.info(
        { postId, platforms: data.platforms, scheduled: !!data.scheduledAt },
        'Post created in Postiz',
      );
      return postId;
    } catch (error) {
      logger.error({ error, platforms: data.platforms }, 'Failed to create post in Postiz');
      throw error;
    }
  }

  /**
   * List posts from Postiz, optionally filtered by status.
   */
  async listPosts(params?: { status?: string }): Promise<any[]> {
    try {
      const query = params?.status ? `?status=${encodeURIComponent(params.status)}` : '';
      const data = await this.request('GET', `/posts${query}`);
      return Array.isArray(data) ? data : data.posts ?? [];
    } catch (error) {
      logger.error({ error, params }, 'Failed to list posts from Postiz');
      throw error;
    }
  }

  /**
   * Fetch analytics from Postiz — includes best posting times and
   * engagement metrics.
   */
  async getAnalytics(): Promise<any> {
    try {
      const data = await this.request('GET', '/analytics');
      logger.info('Postiz analytics fetched');
      return data;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch analytics from Postiz');
      throw error;
    }
  }

  // ── Private helper ───────────────────────────────────────────────

  /**
   * Low-level HTTP request to the Postiz API with a 30-second timeout.
   */
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const { baseUrl, headers } = await this.getConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { status: response.status, errorBody, method, path },
          'Postiz API error response',
        );
        throw new Error(
          `Postiz API responded with ${response.status}: ${errorBody}`,
        );
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Singleton Export ────────────────────────────────────────────────────────

export const postiz = new PostizService();
