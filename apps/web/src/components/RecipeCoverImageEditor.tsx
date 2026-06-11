import type { Recipe } from '@cookyourbooks/domain';
import { useRef, useState } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import { OcrWorkerNotConfiguredError } from '../import/api.js';
import { generateCovers, removeRecipeCover, uploadRecipeCover } from '../recipe/coverApi.js';
import { CoverImage } from './CoverImage.js';
import { DropdownMenu, DropdownMenuItem } from './DropdownMenu.js';

/**
 * Recipe cover: upload / replace / remove a user image, or generate one with
 * Gemini. Parallels CoverImageEditor (collection covers); generation enqueues a
 * single-recipe cover job — the worker stamps cover_image_path server-side, so
 * the new cover flows back in via sync (no local write here).
 *
 * Rendered as the header cover itself (via RecipeHeaderMeta's coverSlot):
 * with a cover, the actions hide behind a small ⋯ menu overlaid on the
 * image; without one, a placeholder invites uploading or generating.
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
    <div className="mt-3 w-full max-w-md">
      {recipe.coverImagePath ? (
        <div className="relative">
          <CoverImage
            path={recipe.coverImagePath}
            alt={`${recipe.title} cover`}
            className="h-48 w-full rounded-lg border border-stone-200 dark:border-stone-700"
          />
          <div className="absolute right-2 top-2">
            <DropdownMenu
              label="Cover options"
              testId="cover-menu"
              triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-full bg-stone-900/60 text-white backdrop-blur-sm hover:bg-stone-900/80"
            >
              {(close) => (
                <>
                  <DropdownMenuItem
                    disabled={busy}
                    onSelect={() => {
                      close();
                      fileInput.current?.click();
                    }}
                  >
                    Replace cover
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={busy}
                    onSelect={() => {
                      close();
                      void generate();
                    }}
                  >
                    ✨ Generate with AI
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    tone="danger"
                    disabled={busy}
                    onSelect={() => {
                      close();
                      void remove();
                    }}
                  >
                    Remove
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenu>
          </div>
        </div>
      ) : (
        <div className="flex h-48 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-600 dark:bg-stone-900">
          <p className="text-sm text-stone-600 dark:text-stone-400">Add a cover</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
            >
              Upload an image
            </button>
            <button
              onClick={generate}
              disabled={busy}
              className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
            >
              ✨ Generate with AI
            </button>
          </div>
        </div>
      )}
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
      {status && <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{status}</p>}
      {error && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
