import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useSync } from '../local/SyncProvider.js';
import { kickOcr, retryRecitationFailures, setRecitationPolicy } from './api.js';
import type { ImportBatch } from './model.js';
import { useUpdateImportBatch } from './queries.js';

/**
 * Copyright-recitation banner + fallback actions. Gemini refuses some
 * copyrighted pages with `finishReason: RECITATION`; the batch then either
 * parks them in NEEDS_FALLBACK (recitation policy ASK) or fails them
 * (OCR_FAILED). The fallback actions are **batch-wide** — retrying re-runs
 * every recitation casualty in the batch — so this same banner works on the
 * batch board *and* at the top of a single page-group's detail page, where it
 * offers to fix "this and all others needing it".
 */
export function RecitationBanner({
  batch,
  needsFallbackCount,
  recitationFailedCount,
  onEditFallback,
}: {
  batch: ImportBatch;
  /** Batch-wide count of items parked in NEEDS_FALLBACK (policy ASK). */
  needsFallbackCount: number;
  /** Batch-wide count of items that failed OCR on recitation. */
  recitationFailedCount: number;
  /** The batch board passes its inline fallback-model editor; the item page
   *  omits it and links back to the board instead. */
  onEditFallback?: () => void;
}) {
  const updateBatch = useUpdateImportBatch();
  const { syncNow } = useSync();
  const [recitationBusy, setRecitationBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryToast, setRetryToast] = useState<string | undefined>();

  const hasFallback = !!batch.fallbackProvider && !!batch.fallbackModel;
  const showAsk = needsFallbackCount > 0 && batch.recitationPolicy === 'ASK';
  const showFail = recitationFailedCount > 0 && batch.recitationPolicy !== 'ASK';
  if (!showAsk && !showFail) return null;

  async function applyRecitation(policy: 'FALLBACK' | 'FAIL') {
    setRecitationBusy(true);
    try {
      await setRecitationPolicy(batch.id, policy);
      await updateBatch.mutateAsync({ id: batch.id, patch: { recitationPolicy: policy } });
      // FALLBACK moves the parked items back to PENDING server-side; kick the
      // worker so they're picked up now instead of at the next pg_cron tick.
      if (policy === 'FALLBACK') {
        try {
          await kickOcr(batch.id);
        } catch {
          // Cron will catch up if the kick fails.
        }
      }
    } finally {
      setRecitationBusy(false);
    }
  }

  async function retryFailedWithFallback() {
    setRetryBusy(true);
    setRetryToast(undefined);
    try {
      const n = await retryRecitationFailures(batch.id);
      await updateBatch.mutateAsync({ id: batch.id, patch: { recitationPolicy: 'FALLBACK' } });
      try {
        await kickOcr(batch.id);
      } catch {
        /* cron will catch up */
      }
      await syncNow();
      setRetryToast(
        n === 0
          ? 'No recitation-failed items to retry.'
          : `Retrying ${n} item${n === 1 ? '' : 's'} with the fallback model.`,
      );
    } catch (e) {
      setRetryToast(`Retry failed: ${(e as Error).message}`);
    } finally {
      setRetryBusy(false);
    }
  }

  return (
    <>
      {showFail && (
        <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-200">
          <div className="font-medium">
            {recitationFailedCount} page{recitationFailedCount === 1 ? '' : 's'} failed on a
            copyright/content-filter refusal.
          </div>
          <div className="mt-1">
            {hasFallback ? (
              <>
                Retry {recitationFailedCount === 1 ? 'it' : 'them'} — and every other recitation
                failure in this batch — with the fallback model ({batch.fallbackModel})?
              </>
            ) : onEditFallback ? (
              <>Set a fallback model first, then retry.</>
            ) : (
              <>
                Set a fallback model on the{' '}
                <Link to={`/import/${batch.id}`} className="font-medium underline">
                  batch board
                </Link>
                , then retry.
              </>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {!hasFallback && onEditFallback && (
              <button
                type="button"
                onClick={onEditFallback}
                className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                Set fallback model
              </button>
            )}
            <button
              type="button"
              onClick={() => void retryFailedWithFallback()}
              disabled={retryBusy || !hasFallback}
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-xs font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
            >
              {retryBusy ? 'Retrying…' : 'Retry with fallback'}
            </button>
            {retryToast && <span className="self-center text-xs">{retryToast}</span>}
          </div>
        </div>
      )}

      {showAsk && (
        <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-200">
          <div className="font-medium">
            {needsFallbackCount} page{needsFallbackCount === 1 ? '' : 's'} hit a
            copyright/content-filter refusal.
          </div>
          <div className="mt-1">
            Use the fallback model{batch.fallbackModel ? ` (${batch.fallbackModel})` : ''} for{' '}
            {needsFallbackCount === 1 ? 'it' : 'them'} — and any others in this batch?
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void applyRecitation('FALLBACK')}
              disabled={recitationBusy}
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-xs font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
            >
              Yes, use fallback
            </button>
            <button
              type="button"
              onClick={() => void applyRecitation('FAIL')}
              disabled={recitationBusy}
              className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60"
            >
              No, mark them failed
            </button>
          </div>
        </div>
      )}
    </>
  );
}
