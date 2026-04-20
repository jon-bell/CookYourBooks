import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { capturePhoto } from './camera.js';
import { OcrNotConfiguredError, ocrImageToRecipe, type OcrProgress } from './ocr.js';

/**
 * Collection-page entry point: capture a photo (native camera or file
 * picker), send it to the configured LLM, and open the recipe editor
 * prefilled with the returned draft.
 */
export function ImportFromPhoto({ collectionId }: { collectionId: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<OcrProgress | undefined>();
  const [error, setError] = useState<React.ReactNode | undefined>();

  async function handleClick() {
    setError(undefined);
    setProgress(undefined);
    const photo = await capturePhoto();
    if (!photo) return;
    setBusy(true);
    try {
      const draft = await ocrImageToRecipe(photo.blob, setProgress);
      navigate(`/collections/${collectionId}/recipes/new`, { state: { draft } });
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

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
      >
        {busy ? 'Reading photo…' : 'Import from photo'}
      </button>
      {progress && <span className="text-xs text-stone-500">{progress.status}…</span>}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
