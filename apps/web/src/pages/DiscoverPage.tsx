import {
  forkCollection,
  listPublicCollectionRecipeTitles,
  listPublicCollections,
  type PublicCollectionSummary,
} from '@cookyourbooks/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider.js';
import { CoverImage } from '../components/CoverImage.js';
import { LoadingState } from '../components/LoadingState.js';
import {
  type GlobalCookbookSummary,
  listGlobalCookbooks,
  listGlobalTocEntries,
} from '../data/globalCookbookLookup.js';
import { useSync } from '../local/SyncProvider.js';
import { ReportDialog } from '../moderation/ReportDialog.js';
import { supabase } from '../supabase.js';

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

  // Global catalog is admin-curated and public-readable. It shows up
  // alongside user-published collections so visitors landing on
  // Discover can browse the whole "known cookbooks" universe at once.
  const { data: globalCatalog } = useQuery<GlobalCookbookSummary[]>({
    queryKey: ['discover-global-cookbooks', q],
    queryFn: () => listGlobalCookbooks(q || undefined),
    // Only show the catalog when the user isn't filtering by source
    // type to a non-cookbook subset, since the catalog is cookbooks-only.
    enabled: sourceType === '' || sourceType === 'PUBLISHED_BOOK',
  });

  // Bulk-prefetch recipe titles for every visible public collection so
  // each card can render an inline "what's inside" preview without an
  // N+1. RLS scopes the rows to `is_public = true` collections, so
  // anon visitors see the same data.
  const collectionIds = (data ?? []).map((c) => c.id);
  const { data: publicTitlesMap } = useQuery({
    queryKey: ['public-collection-titles', collectionIds.join(',')],
    queryFn: () => listPublicCollectionRecipeTitles(supabase, collectionIds),
    enabled: collectionIds.length > 0,
  });

  // Same idea for the global cookbook catalog — ToC entries already
  // live in `global_toc_entries` (admin-curated, public-readable).
  const catalogIds = (globalCatalog ?? []).map((c) => c.id);
  const { data: catalogTocMap } = useQuery({
    queryKey: ['discover-global-toc', catalogIds.join(',')],
    queryFn: () => listGlobalTocEntries(catalogIds),
    enabled: catalogIds.length > 0,
  });

  const fork = useMutation({
    mutationFn: (sourceId: string) => forkCollection(supabase, sourceId),
    onSuccess: async (newId) => {
      // The fork happens server-side — pull it into the local cache before
      // navigating so the collection page has data to render immediately.
      await syncNow();
      qc.invalidateQueries({ queryKey: ['collections', user?.id] });
      qc.invalidateQueries({ queryKey: ['library-summaries', user?.id] });
      navigate(`/collections/${newId}`);
    },
  });

  const catalog = globalCatalog ?? [];
  const showCatalog = catalog.length > 0;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Discover</h1>
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Two ways to find recipes: the <strong>global cookbook catalog</strong> is an admin-curated
        index of known cookbooks — you can browse their tables of contents and seed your own copy by
        ISBN. <strong>Public collections</strong> are user-published libraries you can fork into
        your own account.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search titles…"
          className="flex-1 rounded-md border border-stone-300 dark:border-stone-600 px-3 py-2"
        />
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value)}
          className="rounded border border-stone-300 dark:border-stone-600 px-3 py-2 text-sm"
        >
          <option value="">All types</option>
          <option value="PUBLISHED_BOOK">Cookbooks</option>
          <option value="PERSONAL">Personal</option>
          <option value="WEBSITE">Web</option>
        </select>
      </div>
      {showCatalog && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Global cookbook catalog ({catalog.length})</h2>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.map((cb) => {
              const toc = catalogTocMap?.get(cb.id) ?? [];
              return (
                <li
                  key={cb.id}
                  className="flex gap-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-3"
                  data-testid={`catalog-card-${cb.id}`}
                >
                  <CoverImage
                    path={cb.cover_image_path ?? undefined}
                    className="h-20 w-14 flex-shrink-0 rounded"
                    alt={`${cb.title} cover`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{cb.title}</div>
                    <div className="truncate text-xs text-stone-600 dark:text-stone-400">
                      {cb.author ?? 'Unknown author'}
                      {cb.publication_year && <> · {cb.publication_year}</>}
                    </div>
                    {cb.isbn && (
                      <code className="block truncate text-[10px] text-stone-500 font-mono">
                        {cb.isbn}
                      </code>
                    )}
                    <RecipeTitleList
                      titles={toc.map((t) => ({
                        title: t.title,
                        suffix: t.page_number != null ? `p. ${t.page_number}` : null,
                      }))}
                      emptyMessage="No table of contents yet."
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(showCatalog || (data ?? []).length > 0) && (
        <h2 className="text-lg font-semibold pt-2">Public collections</h2>
      )}
      {isLoading ? (
        <LoadingState surface="discover" hints={['Fetching public collections…']} />
      ) : error ? (
        <p className="text-red-700 dark:text-red-300">{error.message}</p>
      ) : (data ?? []).length === 0 ? (
        <p className="text-stone-600 dark:text-stone-400">
          No public collections match that filter.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(data ?? []).map((c) => (
            <li
              key={c.id}
              className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4 hover:border-stone-400"
              data-testid={`public-card-${c.id}`}
            >
              <div className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
                {c.source_type === 'PUBLISHED_BOOK' && c.author
                  ? `Cookbook · ${c.author}`
                  : c.source_type.replace('_', ' ').toLowerCase()}
              </div>
              <div className="mt-1 text-lg font-medium">{c.title}</div>
              <div className="mt-2 text-sm text-stone-600 dark:text-stone-400">
                {c.recipe_count} {c.recipe_count === 1 ? 'recipe' : 'recipes'}
                {c.owner_name && <span> · by {c.owner_name}</span>}
              </div>
              <RecipeTitleList
                titles={(publicTitlesMap?.get(c.id) ?? []).map((r) => ({
                  title: r.title,
                  suffix: null,
                }))}
                emptyMessage="No recipes yet."
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {user && (
                  <button
                    onClick={() => fork.mutate(c.id)}
                    disabled={fork.isPending}
                    className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
                  >
                    {fork.isPending ? 'Forking…' : 'Fork to library'}
                  </button>
                )}
                {!user && (
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    Sign in to fork
                  </span>
                )}
                {user && (
                  <button
                    onClick={() => setReporting(c)}
                    className="ml-auto rounded-md px-2 py-1 text-xs text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-800"
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
        <div className="rounded border border-red-200 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {fork.error.message}
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

/**
 * Compact recipe-title list shown on each Discover card. Shows the first
 * {@link DEFAULT_PREVIEW} entries and a "Show all N" toggle for the rest
 * — recipe-title lists are unbounded and would otherwise dominate the
 * card height for big cookbooks.
 *
 * Recipe titles aren't copyrightable individually (and indexing them by
 * cookbook is the same posture as Goodreads / Open Library), so this
 * surface is safe for both user-published collections and the
 * admin-curated global catalog.
 */
const DEFAULT_PREVIEW = 5;

function RecipeTitleList({
  titles,
  emptyMessage,
}: {
  titles: { title: string; suffix: string | null }[];
  emptyMessage: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (titles.length === 0) {
    return <p className="mt-2 text-xs italic text-stone-500 dark:text-stone-400">{emptyMessage}</p>;
  }
  const shown = expanded ? titles : titles.slice(0, DEFAULT_PREVIEW);
  const hidden = titles.length - shown.length;
  return (
    <div className="mt-2 text-xs text-stone-700 dark:text-stone-300">
      <ul data-testid="title-list" className="space-y-0.5">
        {shown.map((t, i) => (
          <li key={`${i}-${t.title}`} className="flex items-baseline gap-2">
            <span className="flex-1 truncate">{t.title}</span>
            {t.suffix && (
              <span className="flex-shrink-0 text-stone-500 dark:text-stone-400">{t.suffix}</span>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 text-xs text-stone-500 dark:text-stone-400 underline-offset-2 hover:underline"
        >
          Show all {titles.length}
        </button>
      )}
      {expanded && titles.length > DEFAULT_PREVIEW && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 ml-3 text-xs text-stone-500 dark:text-stone-400 underline-offset-2 hover:underline"
        >
          Show less
        </button>
      )}
    </div>
  );
}
