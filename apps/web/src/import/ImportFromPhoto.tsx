import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ParsedRecipeDraft } from '@cookyourbooks/domain';
import { useAuth } from '../auth/AuthProvider.js';
import { useSync } from '../local/SyncProvider.js';
import { capturePhoto, pickPhoto } from './camera.js';
import { getUserOcrPrefs, listOcrKeys } from './api.js';
import { LocalImportItemRepository } from './localRepos.js';
import { uploadBatch } from './uploadBatch.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../settings/ocrSettings.js';
import { resolveImportFallback } from '../settings/FallbackModelSection.js';
import type { ImportItem } from './model.js';

type Progress = { status: string };

/**
 * Collection-page entry point: capture or upload a photo, kick the
 * server-side OCR pipeline as a 1-item batch, and hand the user to the
 * batch review UI once the worker reports back.
 */
export function ImportFromPhoto({ collectionId }: { collectionId: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { syncNow } = useSync();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | undefined>();
  const [error, setError] = useState<React.ReactNode | undefined>();
  const [pending, setPending] = useState<
    { drafts: ParsedRecipeDraft[]; batchId: string; itemId: string } | undefined
  >();
  const [hasKey, setHasKey] = useState<boolean | undefined>();
  const waitTimer = useRef<number | null>(null);
  const waitController = useRef<{ stop: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listOcrKeys()
      .then((keys) => {
        if (!cancelled) setHasKey(keys.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHasKey(false);
      });
    return () => {
      cancelled = true;
      if (waitTimer.current) window.clearInterval(waitTimer.current);
      if (waitController.current) waitController.current.stop = true;
    };
  }, []);

  function reset() {
    setError(undefined);
    setProgress(undefined);
  }

  async function waitForOcr(itemId: string, ownerId: string): Promise<ImportItem> {
    return new Promise<ImportItem>((resolve, reject) => {
      const start = Date.now();
      const timeoutMs = 5 * 60 * 1000;
      const repo = new LocalImportItemRepository(ownerId);
      const controller = { stop: false };
      waitController.current = controller;
      const tick = async () => {
        if (controller.stop) return;
        try {
          // Force a pull cycle so we don't depend solely on the realtime
          // channel landing the update.
          await syncNow();
          const item = await repo.get(itemId);
          if (item && (item.status === 'OCR_DONE' || item.status === 'OCR_FAILED' || item.status === 'NEEDS_FALLBACK')) {
            if (waitTimer.current) window.clearInterval(waitTimer.current);
            resolve(item);
            return;
          }
          if (Date.now() - start > timeoutMs) {
            if (waitTimer.current) window.clearInterval(waitTimer.current);
            reject(new Error('Timed out waiting for OCR. Check your Imports tab.'));
          }
        } catch (e) {
          if (waitTimer.current) window.clearInterval(waitTimer.current);
          reject(e as Error);
        }
      };
      waitTimer.current = window.setInterval(() => void tick(), 2500);
      void tick();
    });
  }

  async function handlePhoto(photo: { blob: Blob; name: string } | undefined) {
    if (!photo || !user) return;
    setBusy(true);
    try {
      // Initial mount fires listOcrKeys() async. If the user clicks
      // "Take photo" before that resolves, hasKey is undefined and we
      // can't tell whether OCR is configured. Re-fetch synchronously
      // here so the "OCR not configured" surface is deterministic.
      let resolvedHasKey = hasKey;
      if (resolvedHasKey === undefined) {
        try {
          const keys = await listOcrKeys();
          resolvedHasKey = keys.length > 0;
          setHasKey(resolvedHasKey);
        } catch {
          resolvedHasKey = false;
          setHasKey(false);
        }
      }
      if (resolvedHasKey === false) {
        setError(
          <>
            OCR not configured.{' '}
            <Link to="/settings" className="underline">
              Open settings
            </Link>{' '}
            to add an API key.
          </>,
        );
        return;
      }
      // Server-side path: kick off a 1-item batch and wait for the worker.
      const file = new File([photo.blob], photo.name || 'photo.jpg', {
        type: photo.blob.type || 'image/jpeg',
      });
      const prefs = await getUserOcrPrefs().catch(() => null);
      const { fallbackProvider, fallbackModel } = resolveImportFallback();
      setProgress({ status: 'uploading' });
      const defaultProvider = prefs?.provider ?? 'gemini';
      const { batchId, itemIds } = await uploadBatch(
        {
          ownerId: user.id,
          name: `Photo ${new Date().toLocaleString()}`,
          targetCollectionId: collectionId,
          defaultProvider,
          defaultModel: prefs?.model || DEFAULT_MODEL_BY_PROVIDER[defaultProvider],
          fallbackProvider,
          fallbackModel,
          sourceKind: 'IMAGES',
          files: [file],
        },
        (p) => setProgress({ status: p.phase }),
      );
      const itemId = itemIds[0]!;
      setProgress({ status: 'waiting for OCR' });
      const final = await waitForOcr(itemId, user.id);
      if (final.status === 'OCR_FAILED') {
        setError(final.lastError ?? 'OCR failed. See the batch page for details.');
        navigate(`/import/${batchId}/items/${itemId}`);
        return;
      }
      if (final.parsedDrafts.length <= 1) {
        navigate(`/import/${batchId}/items/${itemId}`);
      } else {
        setPending({ drafts: final.parsedDrafts, batchId, itemId });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  }

  async function onTake() {
    reset();
    const photo = await capturePhoto();
    await handlePhoto(photo);
  }

  async function onUpload() {
    reset();
    const photo = await pickPhoto();
    await handlePhoto(photo);
  }

  function openDraft(_draft: ParsedRecipeDraft, index: number) {
    if (!pending) return;
    setPending(undefined);
    navigate(`/import/${pending.batchId}/items/${pending.itemId}?draft=${index}`);
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onTake}
          disabled={busy}
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        >
          {busy ? 'Reading photo…' : 'Take photo'}
        </button>
        <button
          type="button"
          onClick={onUpload}
          disabled={busy}
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        >
          {busy ? 'Reading image…' : 'Upload image'}
        </button>
      </div>
      {progress && <span className="text-xs text-stone-500 dark:text-stone-400">{progress.status}…</span>}
      {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}

      {pending && (
        <RecipePicker
          drafts={pending.drafts}
          onPick={openDraft}
          onDismiss={() => setPending(undefined)}
        />
      )}
    </div>
  );
}

function RecipePicker({
  drafts,
  onPick,
  onDismiss,
}: {
  drafts: ParsedRecipeDraft[];
  onPick: (draft: ParsedRecipeDraft, index: number) => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pick a recipe from the photo"
      data-testid="ocr-recipe-picker"
      className="fixed inset-0 z-20 flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white dark:bg-stone-900 p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Found {drafts.length} recipes</h2>
          <button
            type="button"
            onClick={onDismiss}
            className="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
            aria-label="Cancel"
          >
            Cancel
          </button>
        </div>
        <p className="mb-3 text-xs text-stone-600 dark:text-stone-400">
          Pick which one to review first — the rest stay on the import batch.
        </p>
        <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded border border-stone-200 dark:border-stone-700">
          {drafts.map((d, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => onPick(d, i)}
                className="block w-full px-3 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-900"
              >
                <div className="font-medium">{d.title ?? `Recipe ${i + 1}`}</div>
                <div className="text-xs text-stone-500 dark:text-stone-400">
                  {d.ingredients.length} ingredients · {d.instructions.length} steps
                  {d.pageNumbers && d.pageNumbers.length > 0
                    ? ` · p. ${d.pageNumbers.join(', ')}`
                    : ''}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
