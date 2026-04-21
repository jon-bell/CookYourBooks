import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ParsedRecipeDraft } from '@cookyourbooks/domain';
import { capturePhoto, pickPhoto } from './camera.js';
import { OcrNotConfiguredError, ocrImageToRecipes, type OcrProgress } from './ocr.js';

/**
 * Collection-page entry point: capture or upload a photo, OCR it via
 * the configured LLM, and hand the resulting draft(s) to the editor.
 * When the model finds more than one recipe on the page (cookbook
 * spreads, a recipe + its variation), we surface a small picker.
 */
export function ImportFromPhoto({ collectionId }: { collectionId: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<OcrProgress | undefined>();
  const [error, setError] = useState<React.ReactNode | undefined>();
  const [pending, setPending] = useState<ParsedRecipeDraft[] | undefined>();

  function reset() {
    setError(undefined);
    setProgress(undefined);
  }

  async function handlePhoto(photo: { blob: Blob; name: string } | undefined) {
    if (!photo) return;
    setBusy(true);
    try {
      const drafts = await ocrImageToRecipes(photo.blob, setProgress);
      if (drafts.length === 0) {
        setError('The model returned no recipes.');
        return;
      }
      if (drafts.length === 1) {
        navigate(`/collections/${collectionId}/recipes/new`, {
          state: { draft: drafts[0] },
        });
        return;
      }
      // Multi-recipe — show picker in place. Staying on the collection
      // page lets the user import one, come back, import the next.
      setPending(drafts);
    } catch (e) {
      if (e instanceof OcrNotConfiguredError) {
        setError(
          <>
            {e.message}{' '}
            <Link to="/settings" className="underline">
              Open settings
            </Link>
            .
          </>,
        );
      } else {
        setError((e as Error).message);
      }
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

  function openDraft(draft: ParsedRecipeDraft) {
    setPending(undefined);
    navigate(`/collections/${collectionId}/recipes/new`, { state: { draft } });
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onTake}
          disabled={busy}
          className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        >
          {busy ? 'Reading photo…' : 'Take photo'}
        </button>
        <button
          type="button"
          onClick={onUpload}
          disabled={busy}
          className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        >
          {busy ? 'Reading image…' : 'Upload image'}
        </button>
      </div>
      {progress && <span className="text-xs text-stone-500">{progress.status}…</span>}
      {error && <span className="text-xs text-red-700">{error}</span>}

      {pending && (
        <RecipePicker
          drafts={pending}
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
  onPick: (draft: ParsedRecipeDraft) => void;
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
        className="w-full max-w-md rounded-lg bg-white p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            Found {drafts.length} recipes
          </h2>
          <button
            type="button"
            onClick={onDismiss}
            className="text-sm text-stone-500 hover:text-stone-900"
            aria-label="Cancel"
          >
            Cancel
          </button>
        </div>
        <p className="mb-3 text-xs text-stone-600">
          Pick which one to edit now — you can import the others one at a
          time from this button too.
        </p>
        <ul className="divide-y divide-stone-200 rounded border border-stone-200">
          {drafts.map((d, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => onPick(d)}
                className="block w-full px-3 py-2 text-left hover:bg-stone-50"
              >
                <div className="font-medium">{d.title ?? `Recipe ${i + 1}`}</div>
                <div className="text-xs text-stone-500">
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
