import { useRef, useState } from 'react';
import type { Recipe } from '@cookyourbooks/domain';
import { useAuth } from '../auth/AuthProvider.js';
import { OcrWorkerNotConfiguredError } from '../import/api.js';
import {
  generateCovers,
  removeRecipeCover,
  uploadRecipeCover,
} from '../recipe/coverApi.js';
import { CoverImage } from './CoverImage.js';

/**
 * Recipe cover: upload / replace / remove a user image, or generate one with
 * Gemini. Parallels CoverImageEditor (collection covers); generation enqueues a
 * single-recipe cover job — the worker stamps cover_image_path server-side, so
 * the new cover flows back in via sync (no local write here).
 */
export function RecipeCoverImageEditor({
  recipe,
  onChange,
}: {
  recipe: Recipe;
  onChange: (path: string | undefined) => Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    if (!user) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const path = await uploadRecipeCover(user.id, recipe.id, file, recipe.coverImagePath);
      await onChange(path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!recipe.coverImagePath) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await removeRecipeCover(recipe.coverImagePath);
      await onChange(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await generateCovers('recipe', recipe.id);
      setStatus('Generating cover… it will appear here once the worker finishes.');
    } catch (e) {
      if (e instanceof OcrWorkerNotConfiguredError) setError(e.message);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4">
      <div className="flex flex-wrap items-center gap-4">
        <CoverImage
          path={recipe.coverImagePath}
          alt={`${recipe.title} cover`}
          className="h-24 w-36 rounded-md border border-stone-200 dark:border-stone-700"
        />
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
            >
              {recipe.coverImagePath ? 'Replace cover' : 'Add cover'}
            </button>
            <button
              onClick={generate}
              disabled={busy}
              className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
            >
              ✨ Generate with AI
            </button>
            {recipe.coverImagePath && (
              <button
                onClick={remove}
                disabled={busy}
                className="rounded-md px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = '';
            }}
          />
          {status && <p className="text-xs text-stone-500 dark:text-stone-400">{status}</p>}
          {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}
        </div>
      </div>
    </div>
  );
}
