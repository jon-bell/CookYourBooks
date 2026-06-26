import { Link } from 'react-router-dom';

import { relativeTime } from './format.js';
import { useRecentlyViewed } from './queries.js';

export function RecentlyViewedList({ limit = 50 }: { limit?: number }) {
  const { data: entries = [], isLoading } = useRecentlyViewed(limit);
  const nowMs = Date.now();

  if (isLoading) return null;
  if (entries.length === 0) {
    return <p className="text-sm text-stone-500">Recipes you open will show up here.</p>;
  }

  return (
    <ul
      className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900"
      data-testid="recently-viewed-list"
    >
      {entries.map((e) => (
        <li key={e.recipeId} className="px-4 py-2 text-sm">
          {e.collectionId ? (
            <Link
              to={`/collections/${e.collectionId}/recipes/${e.recipeId}`}
              className="flex items-center justify-between hover:underline"
            >
              <span className="font-medium">{e.recipeTitle ?? 'Recipe'}</span>
              <span className="text-xs text-stone-500">{relativeTime(e.viewedAt, nowMs)}</span>
            </Link>
          ) : (
            <span>{e.recipeTitle ?? 'Recipe'}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
