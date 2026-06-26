import type { ParsedRecipeDraft } from '@cookyourbooks/domain';

import { supabase } from '../supabase.js';

/**
 * Client for the `video-import` Edge Function: send a pasted social-video
 * URL, get back parsed recipe drafts. The user's Gemini key lives in Vault
 * and is resolved server-side, so it never reaches this bundle.
 */

const FUNCTION_PATH = '/functions/v1/video-import';

export type VideoPlatform = 'youtube' | 'tiktok' | 'instagram' | 'website';

export interface VideoImportResult {
  platform: VideoPlatform;
  /** Display title for the per-platform collection, e.g. "YouTube" or the
   * source site's name for a generic website. */
  platformTitle: string;
  sourceUrl: string;
  drafts: ParsedRecipeDraft[];
}

export type VideoImportErrorCode =
  | 'NO_GEMINI_KEY'
  | 'UNSUPPORTED_URL'
  | 'NEEDS_CAPTION'
  | 'EXTRACTION_FAILED'
  | 'UNKNOWN';

export class VideoImportError extends Error {
  constructor(
    public code: VideoImportErrorCode,
    message: string,
    public platform?: VideoPlatform,
  ) {
    super(message);
    this.name = 'VideoImportError';
  }
}

/**
 * Extract a recipe from a video link. Pass `caption` on a retry when the
 * function returned NEEDS_CAPTION (Instagram with no server token).
 */
export async function extractRecipeFromVideo(
  url: string,
  opts: { caption?: string } = {},
): Promise<VideoImportResult> {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new VideoImportError('UNKNOWN', 'Sign in to import from a link.');
  const endpoint = `${import.meta.env.VITE_SUPABASE_URL}${FUNCTION_PATH}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (anonKey) headers.apikey = anonKey;

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url, caption: opts.caption }),
  });
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const code = (json.code as VideoImportErrorCode) ?? 'UNKNOWN';
    const message = (json.error as string) ?? `video-import ${resp.status}`;
    throw new VideoImportError(code, message, json.platform as VideoPlatform | undefined);
  }
  return json as unknown as VideoImportResult;
}
