import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { listMyBlocks, unblockUser } from '../moderation/api.js';

/**
 * Authors this user has blocked from Discover, with an Unblock button each.
 * Reads Supabase directly (blocks aren't in the local-first cache — like
 * reports, they only matter to the online Discover surface).
 */
export function BlockedUsersSection() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['my-blocks'],
    queryFn: listMyBlocks,
  });
  const unblock = useMutation({
    mutationFn: unblockUser,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-blocks'] });
      void qc.invalidateQueries({ queryKey: ['public-collections'] });
    },
  });

  return (
    <section data-testid="blocked-users" className="mt-6 space-y-2">
      <h2 className="text-lg font-semibold">Blocked authors</h2>
      <p className="text-sm text-stone-700 dark:text-stone-300">
        Collections published by these people are hidden from your Discover page.
      </p>
      {isLoading ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-700 dark:text-red-300">{error.message}</p>
      ) : (data ?? []).length === 0 ? (
        <p className="text-sm italic text-stone-500 dark:text-stone-400">
          You haven't blocked anyone.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded border border-stone-200 dark:border-stone-700">
          {(data ?? []).map((b) => (
            <li key={b.blocked_id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>{b.display_name || 'Unnamed user'}</span>
              <button
                type="button"
                onClick={() => unblock.mutate(b.blocked_id)}
                disabled={unblock.isPending}
                aria-label={`Unblock ${b.display_name || 'user'}`}
                className="rounded-md px-2 py-1 text-xs text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
              >
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}
      {unblock.isError && (
        <p className="text-sm text-red-700 dark:text-red-300">{unblock.error.message}</p>
      )}
    </section>
  );
}
