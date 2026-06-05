import { useEffect, useMemo, useState } from 'react';
import { createRecipe } from '@cookyourbooks/domain';
import { useCollection, useSaveRecipe } from '../data/queries.js';
import { scoreTocMatch } from './tocMatch.js';
import type { ImportItemStatus, ImportTocEntry } from './model.js';

/** One editable line in the review table. `include` gates whether the
 *  entry is turned into a placeholder recipe on approve; `existingId`
 *  is set when the entry already matches a recipe in the target
 *  cookbook (so we don't create a duplicate). */
interface ReviewRow {
  /** Stable key — the source entry id. */
  key: string;
  title: string;
  pageNumber: string;
  include: boolean;
  existingTitle: string | null;
}

/**
 * Review-and-approve surface for a Table of Contents page. The OCR
 * worker extracts ToC lines into `import_toc_entries`; until this panel
 * existed those rows were invisible and only ever fed the page-number
 * autocomplete. Here the user can edit each title / page, drop bad
 * lines, and approve — which mints one starred placeholder recipe per
 * kept entry in the target cookbook. Those placeholders are exactly
 * what the Speed Importer's "starred placeholders" queue consumes, so
 * scanning a ToC now bootstraps the whole cookbook.
 *
 * Edits are intentionally ephemeral: the `import_toc_entries` rows are
 * server-owned (CRR-synced from the worker), so we treat them as the
 * immutable OCR result and only persist the recipes the user approves.
 * Re-opening the page re-derives the table from the original entries.
 */
export function TocReviewPanel({
  entries,
  targetCollectionId,
  itemStatus,
  onApproved,
}: {
  entries: readonly ImportTocEntry[];
  targetCollectionId: string;
  itemStatus: ImportItemStatus;
  /** Called after placeholders are created. `created` is how many new
   *  recipes were minted (skipped duplicates don't count). The parent
   *  owns marking the item REVIEWED + advancing. */
  onApproved: (created: number) => Promise<void> | void;
}) {
  const saveRecipe = useSaveRecipe(targetCollectionId);
  // Fetch the *currently-selected* cookbook so the duplicate check
  // tracks the picker above, not whatever the item was first assigned.
  const { data: targetCollection } = useCollection(targetCollectionId || undefined);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // (Re)derive the editable table whenever the underlying entries or the
  // target cookbook change. Existing-recipe matches default the row to
  // excluded so a re-import doesn't double up placeholders.
  const entryKey = useMemo(
    () => entries.map((e) => e.id).join('|'),
    [entries],
  );
  useEffect(() => {
    const existingRecipes = targetCollection?.recipes ?? [];
    setRows(
      entries.map((e) => {
        let existingTitle: string | null = null;
        for (const r of existingRecipes) {
          if (scoreTocMatch(e.title, r.title) >= 0.85) {
            existingTitle = r.title;
            break;
          }
        }
        return {
          key: e.id,
          title: e.title,
          pageNumber: e.pageNumber != null ? String(e.pageNumber) : '',
          include: existingTitle === null,
          existingTitle,
        };
      }),
    );
    // entryKey captures entry identity; targetCollection?.id captures
    // the cookbook we dedupe against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey, targetCollection?.id]);

  const ocrPending = itemStatus === 'PENDING' || itemStatus === 'CLAIMED';
  const includedCount = rows.filter((r) => r.include && r.title.trim()).length;
  const canApprove = !!targetCollectionId && includedCount > 0 && !busy;

  function patchRow(key: string, patch: Partial<ReviewRow>) {
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function setAllIncluded(include: boolean) {
    setRows((cur) => cur.map((r) => ({ ...r, include })));
  }

  async function approve() {
    if (!targetCollectionId) return;
    setError(undefined);
    setBusy(true);
    let created = 0;
    try {
      for (const row of rows) {
        const title = row.title.trim();
        if (!row.include || !title) continue;
        const pn = Number(row.pageNumber);
        const recipe = createRecipe({
          title,
          bookTitle: targetCollection?.title,
          pageNumbers: Number.isFinite(pn) && pn > 0 ? [pn] : undefined,
          // Star the placeholder so it surfaces in the Speed Importer
          // capture queue (and reads as "to scan" in the cookbook).
          starred: true,
        });
        await saveRecipe.mutateAsync(recipe);
        created += 1;
      }
      await onApproved(created);
    } catch (e) {
      setError(`Couldn't create placeholders: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (ocrPending) {
    return (
      <div className="rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4 text-sm text-stone-600 dark:text-stone-400">
        Reading the table of contents… entries will appear here once OCR
        finishes.
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4 text-sm text-stone-600 dark:text-stone-400">
        No table-of-contents entries were extracted from this page. Try
        Re-OCR, or untick "This is a Table of Contents page" if it's a
        regular recipe.
      </div>
    );
  }

  return (
    <div
      data-testid="toc-review-panel"
      className="space-y-3 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4"
    >
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          Review table of contents ({entries.length})
        </h2>
        <p className="text-xs text-stone-600 dark:text-stone-400">
          Approve to create a starred placeholder recipe for each entry in
          the target cookbook. Edit titles or page numbers, and untick
          anything you don't want. The Speed Importer can then walk you
          through scanning each one.
        </p>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => setAllIncluded(true)}
          className="rounded border border-stone-300 dark:border-stone-600 px-2 py-0.5 hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => setAllIncluded(false)}
          className="rounded border border-stone-300 dark:border-stone-600 px-2 py-0.5 hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          Select none
        </button>
        <span className="text-stone-500 dark:text-stone-400">
          {includedCount} of {rows.length} selected
        </span>
      </div>

      <ul className="divide-y divide-stone-200 dark:divide-stone-700">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2 py-2">
            <input
              type="checkbox"
              checked={row.include}
              onChange={(e) => patchRow(row.key, { include: e.target.checked })}
              className="h-4 w-4 shrink-0"
              aria-label={`Include ${row.title || 'entry'}`}
            />
            <input
              value={row.title}
              onChange={(e) => patchRow(row.key, { title: e.target.value })}
              className="min-w-0 flex-1 rounded border border-stone-300 dark:border-stone-600 px-2 py-1 text-sm"
              aria-label="Entry title"
            />
            <input
              value={row.pageNumber}
              onChange={(e) => patchRow(row.key, { pageNumber: e.target.value })}
              inputMode="numeric"
              placeholder="p."
              className="w-16 shrink-0 rounded border border-stone-300 dark:border-stone-600 px-2 py-1 text-sm"
              aria-label="Page number"
            />
            {row.existingTitle && (
              <span
                className="shrink-0 rounded-full bg-stone-200 dark:bg-stone-700 px-2 py-0.5 text-[10px] font-medium text-stone-600 dark:text-stone-300"
                title={`Already in cookbook as "${row.existingTitle}"`}
              >
                exists
              </span>
            )}
          </li>
        ))}
      </ul>

      {!targetCollectionId && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Pick a target cookbook above before creating placeholders.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void approve()}
          disabled={!canApprove}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-600 dark:hover:bg-emerald-500"
        >
          {busy
            ? 'Creating…'
            : `Approve & create ${includedCount} placeholder${includedCount === 1 ? '' : 's'}`}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
