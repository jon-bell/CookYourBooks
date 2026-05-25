import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CoverImage } from '../../components/CoverImage.js';
import {
  adminImportCollection,
  listImportCandidates,
  type ImportCandidate,
} from './api.js';

/**
 * Admin "Import from user library" page.
 *
 * Lists user cookbooks (PUBLISHED_BOOK with an ISBN) that aren't yet in
 * the global catalog. One-click import per row — the underlying RPC
 * copies metadata + recipes into `global_cookbooks` / `global_toc_entries`.
 *
 * The candidates view filters by `not exists` against `global_cookbooks`,
 * so a successful import drops the row from this list on the next
 * refetch (no separate "imported" state needed).
 */
export function GlobalCookbookImport() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['global-toc-import-candidates'],
    queryFn: listImportCandidates,
  });

  // Track which rows the admin just imported in this session. We
  // deliberately do NOT invalidate the candidates query on success —
  // doing so would refetch and drop the row out of `data` before the
  // admin sees the "Imported · edit" affordance. Instead, the row
  // sticks around until the next manual refresh.
  const [importedAs, setImportedAs] = useState<Record<string, string>>({});

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm text-stone-600">
          User cookbooks with an ISBN that aren't yet in the global catalog. Each row's metadata
          (title / author / publisher / cover) and its recipe titles will be copied into the
          catalog.
        </p>
      </div>

      {isLoading && <p className="text-stone-500">Looking for candidates…</p>}
      {error && <p className="text-red-700">{(error as Error).message}</p>}
      {data && data.length === 0 && (
        <p className="rounded-md border border-stone-200 bg-stone-50 p-4 text-stone-600">
          Nothing to import — every user cookbook with an ISBN is already in the catalog.
        </p>
      )}

      {data && data.length > 0 && (
        <ul className="space-y-2">
          {data.map((c) => (
            <CandidateRow
              key={c.collection_id}
              candidate={c}
              importedAs={importedAs[c.collection_id]}
              onImported={(cookbookId) =>
                setImportedAs((prev) => ({ ...prev, [c.collection_id]: cookbookId }))
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CandidateRow({
  candidate,
  importedAs,
  onImported,
}: {
  candidate: ImportCandidate;
  importedAs: string | undefined;
  onImported: (cookbookId: string) => void;
}) {
  const qc = useQueryClient();

  const importMutation = useMutation({
    mutationFn: () => adminImportCollection(candidate.collection_id),
    onSuccess: (cookbookId) => {
      onImported(cookbookId);
      // Refresh the catalog list + banner counts so they reflect the
      // new entry. The candidates list is *not* invalidated — see the
      // parent's note for why.
      qc.invalidateQueries({ queryKey: ['global-cookbooks'] });
    },
  });

  return (
    <li className="flex gap-3 rounded-lg border border-stone-200 bg-white p-3">
      <CoverImage
        path={candidate.cover_image_path ?? undefined}
        className="h-20 w-14 flex-shrink-0 rounded"
        alt={`${candidate.title} cover`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{candidate.title}</div>
        <div className="truncate text-sm text-stone-600">
          {candidate.author ?? 'Unknown author'}
          {candidate.publication_year && <> · {candidate.publication_year}</>}
        </div>
        <div className="text-xs text-stone-500">
          <code className="font-mono">{candidate.isbn ?? '—'}</code>
          {' · '}
          {candidate.recipe_count}{' '}
          {candidate.recipe_count === 1 ? 'recipe' : 'recipes'}
          {' · '}
          owner: {candidate.owner_name ?? candidate.owner_id.slice(0, 8)}
        </div>
        {importMutation.error && (
          <p className="mt-1 text-xs text-red-700">
            {(importMutation.error as Error).message}
          </p>
        )}
      </div>
      <div className="flex flex-col items-end gap-1">
        {importedAs ? (
          <Link
            to={`/admin/global-toc/${importedAs}`}
            className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800 hover:bg-emerald-100"
          >
            Imported · edit
          </Link>
        ) : (
          <button
            onClick={() => importMutation.mutate()}
            disabled={importMutation.isPending}
            className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
          >
            {importMutation.isPending ? 'Importing…' : 'Import'}
          </button>
        )}
      </div>
    </li>
  );
}
