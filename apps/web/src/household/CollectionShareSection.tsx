import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase.js';
import { useMyHousehold, useUnshareCollectionFromHousehold } from './queries.js';
import { ShareWithHouseholdDialog } from './ShareWithHouseholdDialog.js';

/**
 * Renders the household-sharing controls for a collection.
 *
 * - If the collection is not shared with any household: "Share with household" button.
 * - If shared with the user's current household: "Shared with X · Unshare" badge.
 * - If the user has no household: button is disabled with a hint pointing to /household.
 *
 * The "currently shared with household" lookup goes direct to PostgREST
 * rather than through the local SQLite cache. Justification: the
 * household column isn't part of the domain types yet, so a side query
 * with React Query is the smallest-diff way to surface the state, and
 * a household share is a low-frequency operation so the extra RTT
 * doesn't matter.
 */
export function CollectionShareSection({
  collectionId,
  collectionTitle,
}: {
  collectionId: string;
  collectionTitle: string;
}) {
  const my = useMyHousehold();
  const unshare = useUnshareCollectionFromHousehold();
  const [open, setOpen] = useState(false);
  const sharedQuery = useQuery({
    queryKey: ['collection', 'household-share', collectionId],
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from('recipe_collections')
        .select('shared_with_household_id')
        .eq('id', collectionId)
        .maybeSingle();
      if (error) throw error;
      return data?.shared_with_household_id ?? null;
    },
  });

  const sharedWithHouseholdId = sharedQuery.data ?? null;
  const isSharedHere =
    !!sharedWithHouseholdId && my.data?.household.id === sharedWithHouseholdId;

  if (!my.data) {
    // Not in a household at all.
    return (
      <span
        className="text-sm text-stone-500 dark:text-stone-400"
        data-testid="household-share-status"
      >
        <Link to="/household" className="underline">Create a household</Link> to share collections privately
      </span>
    );
  }

  if (isSharedHere) {
    return (
      <div className="flex items-center gap-2" data-testid="household-share-status">
        <span className="rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700 px-2 py-1 text-xs text-emerald-900 dark:text-emerald-200">
          Shared with {my.data.household.name}
        </span>
        <button
          onClick={() =>
            confirm('Stop sharing this collection with your household?') &&
            void unshare.mutateAsync(collectionId)
          }
          data-testid="unshare-collection"
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          Unshare
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        data-testid="share-with-household"
        className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
      >
        Share with household
      </button>
      <ShareWithHouseholdDialog
        open={open}
        collectionId={collectionId}
        collectionTitle={collectionTitle}
        onClose={() => setOpen(false)}
        onShared={() => {
          setOpen(false);
          void sharedQuery.refetch();
        }}
      />
    </>
  );
}
