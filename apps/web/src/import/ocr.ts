import type { ParsedRecipeDraft } from '@cookyourbooks/domain';
import { loadOcrSettings } from '../settings/ocrSettings.js';
import { ocrWithLlm } from './llm.js';

export type OcrProgress = { status: string };

export type OcrShim = (
  source: Blob | File,
  onProgress?: (p: OcrProgress) => void,
) => Promise<ParsedRecipeDraft>;

declare global {
  interface Window {
    /** E2E hook: bypasses the real LLM call and returns a canned draft. */
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
 * Turn a captured photo into a recipe draft via the user's configured LLM
 * provider. Throws {@link OcrNotConfiguredError} when no settings exist —
 * the Import button surface catches that specifically and directs the user
 * to Settings.
 */
export async function ocrImageToRecipe(
  source: Blob | File,
  onProgress?: (p: OcrProgress) => void,
): Promise<ParsedRecipeDraft> {
  if (window.__cybOcrShim) return window.__cybOcrShim(source, onProgress);
  const settings = loadOcrSettings();
  if (!settings) throw new OcrNotConfiguredError();
  return ocrWithLlm(source, settings, onProgress);
}
