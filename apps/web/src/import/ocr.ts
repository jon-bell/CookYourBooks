import type { ParsedRecipeDraft } from '@cookyourbooks/domain';
import { loadOcrSettings } from '../settings/ocrSettings.js';
import { ocrWithLlm } from './llm.js';

export type OcrProgress = { status: string };

export type OcrShim = (
  source: Blob | File,
  onProgress?: (p: OcrProgress) => void,
) => Promise<ParsedRecipeDraft[]>;

declare global {
  interface Window {
    /**
     * E2E hook: bypasses the real LLM call and returns canned drafts.
     * Returning multiple drafts lets tests exercise the multi-recipe
     * picker path.
     */
    __cybOcrShim?: OcrShim;
  }
}

export class OcrNotConfiguredError extends Error {
  constructor() {
    super('OCR is not configured. Open Settings to add your LLM provider and API key.');
    this.name = 'OcrNotConfiguredError';
  }
}

/**
 * Turn a captured photo into one or more recipe drafts via the user's
 * configured LLM provider. A single photograph can contain multiple
 * recipes (a cookbook spread, a hand-written card with variations);
 * callers are responsible for showing a picker when `length > 1`.
 * Throws {@link OcrNotConfiguredError} when no settings exist.
 */
export async function ocrImageToRecipes(
  source: Blob | File,
  onProgress?: (p: OcrProgress) => void,
): Promise<ParsedRecipeDraft[]> {
  if (window.__cybOcrShim) return window.__cybOcrShim(source, onProgress);
  const settings = loadOcrSettings();
  if (!settings) throw new OcrNotConfiguredError();
  return ocrWithLlm(source, settings, onProgress);
}
