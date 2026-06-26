import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { CoverImage } from '../../components/CoverImage.js';
import { adminImportCollection, type ImportCandidate, listImportCandidates } from './api.js';

/**
 * Admin "Import from user library" page.
 *
 * Lists user cookbooks (PUBLISHED_BOOK with an ISBN) that aren't yet in
 * the global catalog. The admin filters by owner, ticks rows (or "select
 * all"), and bulk-imports — the underlying RPC copies metadata + recipes
 * into `global_cookbooks` / `global_toc_entries` one source at a time so
 * partial failures still show progress for the rest.
 *
 * The candidates query is *not* invalidated on success: it would refetch
 * and drop just-imported rows out of `data` before the admin can see the
 * "Imported · edit" link. Local `importedAs` state keeps those rows
 * sticky until the next manual refresh.
 */
export function GlobalCookbookImport() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['global-toc-import-candidates'],
    queryFn: listImportCandidates,
  });

  const [ownerFilter, setOwnerFilter] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importedAs, setImportedAs] = useState<Record<string, string>>({});
  // Snapshot of rows we've imported in this session. Needed because
  // SyncProvider's debounce auto-invalidates most queries on every
  // sync round-trip — the import RPC's own write triggers exactly that.
  // Without this, the candidates query refetches between the RPC return
  // and the next render, drops the just-imported row, and the admin
  // never sees the "Imported · edit" affordance.
  const [importedSnapshots, setImportedSnapshots] = useState<Record<string, ImportCandidate>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [currentlyImporting, setCurrentlyImporting] = useState<string | null>(null);

  // Unique owners with their candidate counts — drives the filter
  // dropdown. Sorted by descending count so the biggest backlogs surface
  // first.
  const owners = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const c of data ?? []) {
      const label = c.owner_name ?? c.owner_id.slice(0, 8);
      const cur = counts.get(c.owner_id);
      counts.set(c.owner_id, { name: label, count: (cur?.count ?? 0) + 1 });
    }
    return Array.from(counts.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [data]);

  // Merge live query data with locally-imported snapshots so just-
  // imported rows stay rendered even after a sync-induced refetch.
  const merged = useMemo(() => {
    const byId = new Map<string, ImportCandidate>((data ?? []).map((c) => [c.collection_id, c]));
    for (const [id, snap] of Object.entries(importedSnapshots)) {
      if (!byId.has(id)) byId.set(id, snap);
    }
    return Array.from(byId.values());
  }, [data, importedSnapshots]);

  const filtered = useMemo(
    () => merged.filter((c) => !ownerFilter || c.owner_id === ownerFilter),
    [merged, ownerFilter],
  );

  // Selectable = filtered AND not yet imported. Used to power "select
  // all" semantics so admins don't accidentally re-trigger imports on
  // rows that have already landed.
  const selectable = useMemo(
    () => filtered.filter((c) => !importedAs[c.collection_id]),
    [filtered, importedAs],
  );
  const selectableIds = useMemo(
    () => new Set(selectable.map((c) => c.collection_id)),
    [selectable],
  );
  const selectedCount = useMemo(
    () => [...selected].filter((id) => selectableIds.has(id)).length,
    [selected, selectableIds],
  );
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;
  const someSelected = selectedCount > 0 && selectedCount < selectable.length;

  const bulkImport = useMutation({
    mutationFn: async () => {
      const candidates = filtered.filter(
        (c) => selected.has(c.collection_id) && !importedAs[c.collection_id],
      );
      for (const c of candidates) {
        const id = c.collection_id;
        setCurrentlyImporting(id);
        try {
          const cookbookId = await adminImportCollection(id);
          setImportedAs((prev) => ({ ...prev, [id]: cookbookId }));
          setImportedSnapshots((prev) => ({ ...prev, [id]: c }));
          setErrors((prev) => {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setSelected((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        } catch (err) {
          setErrors((prev) => ({ ...prev, [id]: (err as Error).message }));
        }
      }
      setCurrentlyImporting(null);
    },
    onSuccess: () => {
      // Refresh the catalog list + banner counts in the sibling tab.
      // The candidates list isn't invalidated here for the reason in
      // the component header.
      qc.invalidateQueries({ queryKey: ['global-cookbooks'] });
    },
  });

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable.map((c) => c.collection_id)));
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm text-stone-600 dark:text-stone-400">
          User cookbooks with an ISBN that aren't yet in the global catalog. Tick the rows you want
          and click <em>Import selected</em>. Each row's metadata (title / author / publisher /
          cover) and its recipe titles get copied into the catalog.
        </p>
      </div>

      {isLoading && <p className="text-stone-500">Looking for candidates…</p>}
      {error && <p className="text-red-700">{error.message}</p>}

      {data && merged.length === 0 && (
        <p className="rounded-md border border-stone-200 bg-stone-50 dark:bg-stone-900 p-4 text-stone-600 dark:text-stone-400">
          Nothing to import — every user cookbook with an ISBN is already in the catalog.
        </p>
      )}

      {data && merged.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-900 p-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-stone-600 dark:text-stone-400">Owner:</span>
              <select
                value={ownerFilter}
                onChange={(e) => {
                  setOwnerFilter(e.target.value);
                  // Owner change can change the selectable set; drop
                  // any selections that are no longer in scope.
                  setSelected(new Set());
                }}
                className="rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-2 py-1 text-sm"
              >
                <option value="">All owners ({data.length})</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({o.count})
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label="Select all visible candidates"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={toggleAll}
                disabled={selectable.length === 0}
              />
              <span className="text-stone-700 dark:text-stone-300">
                Select all ({selectable.length})
              </span>
            </label>

            <button
              onClick={() => bulkImport.mutate()}
              disabled={selectedCount === 0 || bulkImport.isPending}
              className="ml-auto rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
            >
              {bulkImport.isPending
                ? `Importing ${selectedCount}…`
                : `Import selected (${selectedCount})`}
            </button>
          </div>

          {filtered.length === 0 ? (
            <p className="rounded-md border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-900 p-4 text-stone-600 dark:text-stone-400">
              No candidates from that owner.
            </p>
          ) : (
            <ul className="space-y-2">
              {filtered.map((c) => (
                <CandidateRow
                  key={c.collection_id}
                  candidate={c}
                  selected={selected.has(c.collection_id)}
                  onToggle={() => toggleOne(c.collection_id)}
                  importedAs={importedAs[c.collection_id]}
                  busy={currentlyImporting === c.collection_id}
                  error={errors[c.collection_id]}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function CandidateRow({
  candidate,
  selected,
  onToggle,
  importedAs,
  busy,
  error,
}: {
  candidate: ImportCandidate;
  selected: boolean;
  onToggle: () => void;
  importedAs: string | undefined;
  busy: boolean;
  error: string | undefined;
}) {
  const alreadyImported = !!importedAs;
  return (
    <li className="flex gap-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-3">
      <div className="flex items-center">
        <input
          type="checkbox"
          aria-label={`Select ${candidate.title}`}
          checked={selected}
          onChange={onToggle}
          disabled={alreadyImported}
        />
      </div>
      <CoverImage
        path={candidate.cover_image_path ?? undefined}
        className="h-20 w-14 flex-shrink-0 rounded"
        alt={`${candidate.title} cover`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{candidate.title}</div>
        <div className="truncate text-sm text-stone-600 dark:text-stone-400">
          {candidate.author ?? 'Unknown author'}
          {candidate.publication_year && <> · {candidate.publication_year}</>}
        </div>
        <div className="text-xs text-stone-500">
          <code className="font-mono">{candidate.isbn ?? '—'}</code>
          {' · '}
          {candidate.recipe_count} {candidate.recipe_count === 1 ? 'recipe' : 'recipes'}
          {' · '}
          owner: {candidate.owner_name ?? candidate.owner_id.slice(0, 8)}
        </div>
        {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      </div>
      <div className="flex flex-col items-end gap-1">
        {alreadyImported ? (
          <Link
            to={`/admin/global-toc/${importedAs}`}
            className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-1.5 text-sm text-emerald-800 dark:text-emerald-200 hover:bg-emerald-100"
          >
            Imported · edit
          </Link>
        ) : busy ? (
          <span className="text-xs text-stone-500">Importing…</span>
        ) : null}
      </div>
    </li>
  );
}
