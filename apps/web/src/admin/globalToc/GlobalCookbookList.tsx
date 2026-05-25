import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CoverImage } from '../../components/CoverImage.js';
import {
  createCookbook,
  deleteCookbook,
  listCookbooks,
  listImportCandidates,
  type GlobalCookbook,
} from './api.js';

export function GlobalCookbookList() {
  const [search, setSearch] = useState('');
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['global-cookbooks', search],
    queryFn: () => listCookbooks(search),
  });

  const create = useMutation({
    mutationFn: () => createCookbook({ title: 'Untitled cookbook' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['global-cookbooks'] }),
  });

  const remove = useMutation({
    mutationFn: deleteCookbook,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['global-cookbooks'] }),
  });

  // Surface the size of the import backlog so admins know to clear it
  // without having to click into the tab. Errors here are silent — the
  // banner is decorative; the actual import page renders its own.
  const { data: candidates } = useQuery({
    queryKey: ['global-toc-import-candidates'],
    queryFn: listImportCandidates,
    staleTime: 30_000,
  });
  const candidateCount = candidates?.length ?? 0;

  return (
    <div className="space-y-4">
      {candidateCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>
            {candidateCount} user cookbook{candidateCount === 1 ? '' : 's'} with an ISBN{' '}
            {candidateCount === 1 ? 'is' : 'are'} not yet in the global catalog.
          </span>
          <Link
            to="/admin/global-toc/import"
            className="rounded-md bg-amber-900 px-3 py-1 text-xs font-medium text-amber-50 hover:bg-amber-800"
          >
            Review →
          </Link>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, author, or ISBN"
          className="flex-1 min-w-[14rem] rounded-md border border-stone-300 px-3 py-1.5 text-sm"
        />
        <button
          onClick={() => create.mutate()}
          disabled={create.isPending}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
        >
          New cookbook
        </button>
      </div>

      {create.error && (
        <p className="text-sm text-red-700">{(create.error as Error).message}</p>
      )}

      {isLoading && <p className="text-stone-500">Loading…</p>}
      {error && <p className="text-red-700">{(error as Error).message}</p>}
      {data && data.length === 0 && (
        <p className="text-stone-600">
          No cookbooks yet. Click <em>New cookbook</em> to start one — you can ISBN-lookup the
          metadata after.
        </p>
      )}

      {data && data.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {data.map((c) => (
            <li
              key={c.id}
              className="flex gap-3 rounded-lg border border-stone-200 bg-white p-3"
            >
              <CoverImage
                path={c.cover_image_path ?? undefined}
                className="h-20 w-14 flex-shrink-0 rounded"
                alt={`${c.title} cover`}
              />
              <div className="min-w-0 flex-1">
                <Link
                  to={`/admin/global-toc/${c.id}`}
                  className="block truncate font-medium hover:underline"
                >
                  {c.title}
                </Link>
                <div className="truncate text-sm text-stone-600">
                  {c.author ?? 'Unknown author'}
                </div>
                <div className="text-xs text-stone-500">
                  {c.isbn ? <code className="font-mono">{c.isbn}</code> : 'No ISBN'}
                  {c.publication_year && <> · {c.publication_year}</>}
                </div>
              </div>
              <DeleteButton cookbook={c} onConfirm={() => remove.mutate(c.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeleteButton({
  cookbook,
  onConfirm,
}: {
  cookbook: GlobalCookbook;
  onConfirm: () => void;
}) {
  return (
    <button
      onClick={() => {
        if (
          confirm(
            `Delete "${cookbook.title}" and all its ToC entries? This cannot be undone.`,
          )
        ) {
          onConfirm();
        }
      }}
      className="text-xs text-red-700 hover:underline self-start"
      aria-label={`Delete ${cookbook.title}`}
    >
      Delete
    </button>
  );
}
