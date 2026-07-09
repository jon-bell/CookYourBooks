import { useMemo, useState } from 'react';

import { useDeleteRecipe } from '../data/queries.js';
import { countDuplicates, type DedupRecipe, findDuplicateClusters } from '../import/recipeDedup.js';
import type { CollectionRecipeSummary } from '../local/repositories.js';

/**
 * Collection "table of contents" self-heal. Detects likely-duplicate recipes
 * (see `recipeDedup.ts` — the bilingual-cookbook failure mode) and offers a
 * preview-first cleanup. It NEVER deletes without an explicit confirm, and it
 * always keeps the row with real content over an empty placeholder. Self-hides
 * when a collection has no detectable duplicates, so it's safe to render on
 * every collection.
 */
function toDedup(r: CollectionRecipeSummary): DedupRecipe {
  return {
    id: r.id,
    title: r.title,
    firstPage: r.pageNumbers[0] ?? null,
    hasContent: r.ingredientCount > 0 || r.instructionCount > 0,
    completeness: r.ingredientCount + r.instructionCount,
  };
}

export function DuplicateRecipesTool({
  collectionId,
  recipes,
}: {
  collectionId: string;
  recipes: readonly CollectionRecipeSummary[];
}) {
  const clusters = useMemo(() => findDuplicateClusters(recipes.map(toDedup)), [recipes]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const del = useDeleteRecipe(collectionId);

  const dupCount = countDuplicates(clusters);
  if (dupCount === 0) return null;

  async function runCleanup() {
    setBusy(true);
    setProgress(0);
    const victims = clusters.flatMap((c) => c.duplicates);
    for (let i = 0; i < victims.length; i += 1) {
      try {
        await del.mutateAsync(victims[i]!.id);
      } catch {
        // Best-effort: skip a row that won't delete, keep going.
      }
      setProgress(i + 1);
    }
    setBusy(false);
    setOpen(false);
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
        <span>
          <strong>{dupCount}</strong> likely-duplicate {dupCount === 1 ? 'recipe' : 'recipes'} found
          across <strong>{clusters.length}</strong> {clusters.length === 1 ? 'title' : 'titles'} —
          often from re-scanning a book that already had a table of contents.
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded-md border border-amber-400 bg-white px-3 py-1.5 font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-600 dark:bg-stone-900 dark:text-amber-200 dark:hover:bg-stone-800"
        >
          Review &amp; clean up
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Clean up duplicate recipes"
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/50 p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="flex max-h-[85dvh] w-full max-w-2xl flex-col rounded-lg bg-white p-5 shadow-lg dark:bg-stone-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              Clean up duplicate recipes
            </h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              We'll keep one recipe per group (the one with real content) and remove{' '}
              <strong>{dupCount}</strong> duplicate {dupCount === 1 ? 'row' : 'rows'}. Review below
              — nothing is deleted until you confirm.
            </p>

            <ul className="mt-3 flex-1 space-y-3 overflow-y-auto">
              {clusters.map((c) => (
                <li
                  key={c.survivor.id}
                  className="rounded-md border border-stone-200 p-3 dark:border-stone-700"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200">
                      Keep
                    </span>
                    <span className="text-sm text-stone-900 dark:text-stone-100">
                      {c.survivor.title}
                      {!c.survivor.hasContent && (
                        <span className="text-stone-500 dark:text-stone-400"> (placeholder)</span>
                      )}
                    </span>
                  </div>
                  <ul className="mt-1.5 space-y-1 pl-1">
                    {c.duplicates.map((d) => (
                      <li key={d.id} className="flex items-start gap-2">
                        <span className="mt-0.5 shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/60 dark:text-red-200">
                          Remove
                        </span>
                        <span className="text-sm text-stone-500 line-through dark:text-stone-400">
                          {d.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex items-center justify-end gap-2">
              {busy && (
                <span className="mr-auto text-xs text-stone-500 dark:text-stone-400">
                  Removing {progress}/{dupCount}…
                </span>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100 disabled:opacity-50 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runCleanup()}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? 'Removing…' : `Remove ${dupCount} duplicate${dupCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
