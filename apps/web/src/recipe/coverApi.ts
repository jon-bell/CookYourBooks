// Recipe cover-image client API.
//
// Two paths: a manual upload (straight to the public `covers` bucket, same as
// collection covers) and Gemini bulk generation (enqueue jobs + kick the
// import-worker, which drains recipe_cover_jobs). Both stamp
// recipes.cover_image_path — the upload path via the normal recipe save/push,
// the generation path server-side under the worker's service role.

import { supabase } from '../supabase.js';
import { OcrWorkerNotConfiguredError } from '../import/api.js';
import {
  COVER_CACHE_CONTROL,
  COVER_THUMB_MAX_EDGE,
  coverObjectKey,
  prepareCoverImage,
  thumbPathFor,
} from './coverImage.js';

export type CoverScope = 'recipe' | 'collection' | 'library';

/** Enqueue cover-generation jobs for a scope. Returns how many were queued. */
export async function enqueueCoverJobs(scope: CoverScope, targetId?: string): Promise<number> {
  const { data, error } = await supabase.rpc('cover_jobs_enqueue', {
    p_scope: scope,
    p_target_id: targetId ?? undefined,
  });
  if (error) throw error;
  return typeof data === 'number' ? data : 0;
}

/** Wake the cover worker. Surfaces the not-configured error like the OCR kick. */
export async function kickCoverWorker(): Promise<void> {
  const { error } = await supabase.rpc('cover_kick');
  if (error) {
    if (error.message?.startsWith('COVER_WORKER_NOT_CONFIGURED')) {
      throw new OcrWorkerNotConfiguredError(error.message);
    }
    throw error;
  }
}

/** Enqueue + best-effort kick. Returns the queued count; the cron tick drains the tail. */
export async function generateCovers(scope: CoverScope, targetId?: string): Promise<number> {
  const queued = await enqueueCoverJobs(scope, targetId);
  if (queued > 0) await kickCoverWorker();
  return queued;
}

/**
 * Enqueue a single *collection*-level cover job (Gemini invents a cookbook
 * cover from the collection title + its table of contents) and kick the worker.
 * Distinct from `cover_jobs_enqueue('collection', …)`, which generates one cover
 * per recipe. The new cover streams back via the normal collection sync.
 */
export async function enqueueCollectionCover(collectionId: string): Promise<void> {
  const { error } = await supabase.rpc('collection_cover_enqueue', {
    p_collection_id: collectionId,
  });
  if (error) throw error;
  await kickCoverWorker();
}

export interface CoverJobProgress {
  pending: number;
  claimed: number;
  done: number;
  failed: number;
}

/** Cover-job counts the caller can see (their own jobs + jobs against their recipes). */
export async function getCoverJobProgress(): Promise<CoverJobProgress> {
  const { data, error } = await supabase
    .from('recipe_cover_jobs')
    .select('status');
  if (error) throw error;
  const counts: CoverJobProgress = { pending: 0, claimed: 0, done: 0, failed: 0 };
  for (const row of (data ?? []) as { status: string }[]) {
    if (row.status === 'PENDING') counts.pending++;
    else if (row.status === 'CLAIMED') counts.claimed++;
    else if (row.status === 'DONE') counts.done++;
    else if (row.status === 'FAILED') counts.failed++;
  }
  return counts;
}

// ---------- manual upload ----------

/**
 * Downscale + re-encode a user-chosen cover, upload it to a content-addressed
 * path, and return that path to store on the recipe. Removes `previousPath`
 * when the new (hashed) key differs so a replaced cover doesn't orphan bytes.
 */
export async function uploadRecipeCover(
  userId: string,
  recipeId: string,
  file: File,
  previousPath?: string,
): Promise<string> {
  const { blob, ext, contentType } = await prepareCoverImage(file);
  const path = await coverObjectKey(`${userId}/recipes`, recipeId, await blob.arrayBuffer(), ext);
  const { error } = await supabase.storage
    .from('covers')
    .upload(path, blob, { upsert: true, contentType, cacheControl: COVER_CACHE_CONTROL });
  if (error) throw error;

  // Best-effort thumbnail upload — a missing thumb never fails the cover set.
  try {
    const thumb = await prepareCoverImage(file, COVER_THUMB_MAX_EDGE);
    await supabase.storage.from('covers').upload(thumbPathFor(path), thumb.blob, {
      upsert: true,
      contentType: thumb.contentType,
      cacheControl: COVER_CACHE_CONTROL,
    });
  } catch (e) {
    console.warn('recipe cover thumb upload failed (non-fatal):', e);
  }

  if (previousPath && previousPath !== path) {
    await supabase.storage.from('covers').remove([previousPath, thumbPathFor(previousPath)]);
  }
  return path;
}

export async function removeRecipeCover(path: string): Promise<void> {
  const { error } = await supabase.storage.from('covers').remove([path, thumbPathFor(path)]);
  if (error) throw error;
}

// ---------- prefs (model + prompt) ----------

export interface UserCoverPrefs {
  model: string;
  prompt: string;
  updated_at: string;
}

export const DEFAULT_COVER_MODEL = 'gemini-3.1-flash-image';
export const DEFAULT_COVER_PROMPT =
  'A thumbnail to put on a recipe card for this recipe, RECIPE NAME, composed as a wide 3:2 landscape (horizontal) image that fills the entire frame. Ingredients <INGREDIENTS>. Instructions <INSTRUCTIONS>. Photographic food image only — do not render any text, words, letters, numbers, labels, captions, or watermarks anywhere on the image.';

export async function getUserCoverPrefs(): Promise<UserCoverPrefs | null> {
  const { data, error } = await supabase
    .from('user_cover_prefs')
    .select('model, prompt, updated_at')
    .maybeSingle();
  if (error) throw error;
  return (data as UserCoverPrefs) ?? null;
}

export async function setUserCoverPrefs(prefs: { model: string; prompt: string }): Promise<void> {
  const { error } = await supabase.rpc('user_cover_prefs_set', {
    p_model: prefs.model,
    p_prompt: prefs.prompt,
  });
  if (error) throw error;
}
