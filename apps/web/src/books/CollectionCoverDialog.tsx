import { useEffect, useMemo, useState } from 'react';
import { CoverImage } from '../components/CoverImage.js';
import { uploadCollectionCover } from './cover.js';
import { buildCollectionCoverCollage } from './coverCollage.js';
import { enqueueCollectionCover } from '../recipe/coverApi.js';

interface RecipeCoverChoice {
  id: string;
  title: string;
  coverImagePath: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  userId: string;
  collectionId: string;
  collectionTitle: string;
  previousCoverPath?: string;
  recipes: readonly RecipeCoverChoice[];
  /** Called with the new storage path after a collage is uploaded. */
  onCoverSaved: (path: string) => void | Promise<void>;
}

type Mode = 'collage' | 'ai';

/**
 * Auto-generate a collection cover, two ways:
 *  - **Collage:** pick 1 or 4 of the collection's recipe covers, composed at the
 *    cover aspect ratio with an optional title overlay (client-side canvas).
 *  - **AI:** Gemini invents a cover from the collection title + its full table
 *    of contents (queued server-side; streams back via sync).
 */
export function CollectionCoverDialog({
  open,
  onClose,
  userId,
  collectionId,
  collectionTitle,
  previousCoverPath,
  recipes,
  onCoverSaved,
}: Props) {
  const withCovers = useMemo(
    () => recipes.filter((r): r is RecipeCoverChoice & { coverImagePath: string } => !!r.coverImagePath),
    [recipes],
  );

  const [mode, setMode] = useState<Mode>('collage');
  const [count, setCount] = useState<1 | 4>(withCovers.length >= 4 ? 4 : 1);
  const [selected, setSelected] = useState<string[]>([]);
  const [overlayOn, setOverlayOn] = useState(true);
  const [overlayText, setOverlayText] = useState(collectionTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiQueued, setAiQueued] = useState(false);

  // Reset transient state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setMode('collage');
      setCount(withCovers.length >= 4 ? 4 : 1);
      setSelected([]);
      setOverlayOn(true);
      setOverlayText(collectionTitle);
      setBusy(false);
      setError(null);
      setAiQueued(false);
    }
  }, [open, collectionTitle, withCovers.length]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (count === 1) return [id];
      if (prev.length >= 4) return prev; // cap at 4
      return [...prev, id];
    });
  }

  function pickCount(n: 1 | 4) {
    setCount(n);
    setSelected((prev) => (n === 1 ? prev.slice(0, 1) : prev.slice(0, 4)));
  }

  async function createCollage() {
    setBusy(true);
    setError(null);
    try {
      const paths = selected
        .map((id) => withCovers.find((r) => r.id === id)?.coverImagePath)
        .filter((p): p is string => !!p);
      const blob = await buildCollectionCoverCollage({
        coverPaths: paths,
        overlayText: overlayOn ? overlayText : undefined,
      });
      const path = await uploadCollectionCover(userId, collectionId, blob, previousCoverPath);
      await onCoverSaved(path);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function generateWithAi() {
    setBusy(true);
    setError(null);
    try {
      await enqueueCollectionCover(collectionId);
      setAiQueued(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canCreate = selected.length === count && !busy;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="collection-cover-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-hidden rounded-lg bg-white dark:bg-stone-900 p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="collection-cover-title" className="text-lg font-semibold">
          Generate a cover for “{collectionTitle}”
        </h2>

        <div role="tablist" className="inline-flex self-start overflow-hidden rounded-md border border-stone-300 dark:border-stone-600 text-sm">
          {(['collage', 'ai'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              disabled={busy}
              className={`px-3 py-1.5 ${
                mode === m
                  ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                  : 'hover:bg-stone-100 dark:hover:bg-stone-800'
              }`}
            >
              {m === 'collage' ? 'Collage of recipe covers' : 'AI from contents'}
            </button>
          ))}
        </div>

        {mode === 'collage' ? (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            {withCovers.length === 0 ? (
              <p className="text-sm text-stone-600 dark:text-stone-400">
                None of this collection's recipes have a cover image yet. Generate
                some recipe covers first, or use “AI from contents”.
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-stone-600 dark:text-stone-400">Use</span>
                  {([1, 4] as const).map((n) => (
                    <button
                      key={n}
                      onClick={() => pickCount(n)}
                      disabled={n === 4 && withCovers.length < 4}
                      className={`rounded-md border px-2.5 py-1 ${
                        count === n
                          ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
                          : 'border-stone-300 dark:border-stone-600 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40'
                      }`}
                    >
                      {n === 1 ? '1 cover' : '4 covers'}
                    </button>
                  ))}
                  <span className="ml-auto text-xs text-stone-500 dark:text-stone-400">
                    {selected.length}/{count} selected
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {withCovers.map((r) => {
                    const order = selected.indexOf(r.id);
                    const isSelected = order >= 0;
                    return (
                      <button
                        key={r.id}
                        onClick={() => toggleSelect(r.id)}
                        title={r.title}
                        className={`relative overflow-hidden rounded-md border-2 ${
                          isSelected
                            ? 'border-emerald-500'
                            : 'border-transparent hover:border-stone-300 dark:hover:border-stone-600'
                        }`}
                      >
                        <CoverImage
                          path={r.coverImagePath}
                          variant="thumb"
                          alt={r.title}
                          className="aspect-[2/3] w-full object-cover"
                        />
                        {isSelected && (
                          <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[11px] font-semibold text-white">
                            {count === 1 ? '✓' : order + 1}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={overlayOn}
                    onChange={(e) => setOverlayOn(e.target.checked)}
                  />
                  <span>Add title overlay</span>
                </label>
                {overlayOn && (
                  <input
                    type="text"
                    value={overlayText}
                    onChange={(e) => setOverlayText(e.target.value)}
                    placeholder="Cover title…"
                    className="min-w-0 rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm"
                  />
                )}
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            {aiQueued ? (
              <p className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-emerald-900 dark:text-emerald-200">
                Generating a cover from “{collectionTitle}” and its {recipes.length}{' '}
                {recipes.length === 1 ? 'recipe' : 'recipes'}. It'll appear on the
                collection shortly.
              </p>
            ) : (
              <p className="text-stone-600 dark:text-stone-400">
                Gemini will design a cookbook cover from the collection title and its
                table of contents ({recipes.length}{' '}
                {recipes.length === 1 ? 'recipe' : 'recipes'}). This uses your
                configured LLM key and appears under the LLM Cost Center.
              </p>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60"
          >
            {aiQueued ? 'Close' : 'Cancel'}
          </button>
          {mode === 'collage' ? (
            <button
              onClick={() => void createCollage()}
              disabled={!canCreate}
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create cover'}
            </button>
          ) : (
            !aiQueued && (
              <button
                onClick={() => void generateWithAi()}
                disabled={busy}
                className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
              >
                {busy ? 'Queuing…' : 'Generate with AI'}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
