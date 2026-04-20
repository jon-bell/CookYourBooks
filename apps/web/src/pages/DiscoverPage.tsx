import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  forkCollection,
  listPublicCollections,
  type PublicCollectionSummary,
} from '@cookyourbooks/db';
import { supabase } from '../supabase.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useSync } from '../local/SyncProvider.js';
import { ReportDialog } from '../moderation/ReportDialog.js';

export function DiscoverPage() {
  const [q, setQ] = useState('');
  const [sourceType, setSourceType] = useState<string>('');
  const [reporting, setReporting] = useState<PublicCollectionSummary | undefined>();
  const { user } = useAuth();
  const { syncNow } = useSync();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<PublicCollectionSummary[]>({
    queryKey: ['public-collections', q, sourceType],
    queryFn: () =>
      listPublicCollections(supabase, {
        search: q || undefined,
        sourceType: sourceType || undefined,
        limit: 50,
      }),
  });

  const fork = useMutation({
    mutationFn: (sourceId: string) => forkCollection(supabase, sourceId),
    onSuccess: async (newId) => {
      // The fork happens server-side — pull it into the local cache before
      // navigating so the collection page has data to render immediately.
      await syncNow();
      qc.invalidateQueries({ queryKey: ['collections', user?.id] });
      navigate(`/collections/${newId}`);
    },
  });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Discover public collections</h1>
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search titles…"
          className="flex-1 rounded-md border border-stone-300 px-3 py-2"
        />
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value)}
          className="rounded border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="">All types</option>
          <option value="PUBLISHED_BOOK">Cookbooks</option>
          <option value="PERSONAL">Personal</option>
          <option value="WEBSITE">Web</option>
        </select>
      </div>
      {isLoading ? (
        <p className="text-stone-500">Loading…</p>
      ) : error ? (
        <p className="text-red-700">{(error as Error).message}</p>
      ) : (data ?? []).length === 0 ? (
        <p className="text-stone-600">No public collections match that filter.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(data ?? []).map((c) => (
            <li
              key={c.id}
              className="rounded-lg border border-stone-200 bg-white p-4 hover:border-stone-400"
            >
              <div className="text-xs uppercase tracking-wide text-stone-500">
                {c.source_type === 'PUBLISHED_BOOK' && c.author
                  ? `Cookbook · ${c.author}`
                  : c.source_type.replace('_', ' ').toLowerCase()}
              </div>
              <div className="mt-1 text-lg font-medium">{c.title}</div>
              <div className="mt-2 text-sm text-stone-600">
                {c.recipe_count} {c.recipe_count === 1 ? 'recipe' : 'recipes'}
                {c.owner_name && <span> · by {c.owner_name}</span>}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {user && (
                  <button
                    onClick={() => fork.mutate(c.id)}
                    disabled={fork.isPending}
                    className="rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-800 disabled:opacity-50"
                  >
                    {fork.isPending ? 'Forking…' : 'Fork to library'}
                  </button>
                )}
                {!user && (
                  <span className="text-xs text-stone-500">Sign in to fork</span>
                )}
                {user && (
                  <button
                    onClick={() => setReporting(c)}
                    className="ml-auto rounded-md px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-800"
                    aria-label={`Report ${c.title}`}
                  >
                    Report
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {fork.isError && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {(fork.error as Error).message}
        </div>
      )}
      <ReportDialog
        open={!!reporting}
        onClose={() => setReporting(undefined)}
        targetType="COLLECTION"
        targetId={reporting?.id ?? ''}
        targetLabel={reporting?.title ?? ''}
      />
    </div>
  );
}
