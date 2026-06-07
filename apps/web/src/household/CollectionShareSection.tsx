import { Link } from 'react-router-dom';
import { useMyHousehold } from './queries.js';

/**
 * Read-only household-sharing status for a collection.
 *
 * Sharing is no longer per-collection — it's a library-wide property of
 * household membership (see `LibrarySharingSection` on /household). This
 * component just reflects the current state on the collection page and
 * points at the household settings to change it.
 */
export function CollectionShareSection() {
  const my = useMyHousehold();

  if (!my.data) {
    return (
      <span
        className="text-sm text-stone-500 dark:text-stone-400"
        data-testid="household-share-status"
      >
        <Link to="/household" className="underline">
          Create a household
        </Link>{' '}
        to share your library privately
      </span>
    );
  }

  if (my.data.libraryShared) {
    return (
      <span className="flex items-center gap-2" data-testid="household-share-status">
        <span className="rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700 px-2 py-1 text-xs text-emerald-900 dark:text-emerald-200">
          Shared with {my.data.household.name}
        </span>
        <Link
          to="/household"
          className="text-xs text-stone-500 dark:text-stone-400 underline-offset-2 hover:underline"
        >
          Manage
        </Link>
      </span>
    );
  }

  return (
    <span
      className="text-sm text-stone-500 dark:text-stone-400"
      data-testid="household-share-status"
    >
      Library sharing is off ·{' '}
      <Link to="/household" className="underline">
        Turn it on
      </Link>
    </span>
  );
}
