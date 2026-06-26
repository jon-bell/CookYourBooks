import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useRecipesByTag } from '../cooking/queries.js';
import { TagFilterBar } from '../cooking/TagFilterBar.js';

export function TagBrowsePage() {
  const { tag } = useParams();
  const [selected, setSelected] = useState<string[]>([]);

  // Seed the selection from /tags/:tag.
  useEffect(() => {
    if (tag) setSelected([decodeURIComponent(tag)]);
  }, [tag]);

  const { data: hits = [], isLoading } = useRecipesByTag(selected);

  function toggle(label: string) {
    setSelected((cur) => (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-2xl font-semibold">Browse by tag</h1>
      <TagFilterBar selected={selected} onToggle={toggle} />

      {selected.length === 0 ? (
        <p className="text-sm text-stone-500">Select one or more tags to see matching recipes.</p>
      ) : isLoading ? null : hits.length === 0 ? (
        <p className="text-sm text-stone-500">No recipes match the selected tags.</p>
      ) : (
        <ul
          className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900"
          data-testid="tag-results"
        >
          {hits.map((h) => (
            <li key={h.recipeId}>
              <Link
                to={`/collections/${h.collectionId}/recipes/${h.recipeId}`}
                className="flex items-center justify-between px-4 py-2 text-sm hover:bg-stone-50 dark:hover:bg-stone-900"
              >
                <span className="font-medium">{h.recipeTitle}</span>
                <span className="text-xs text-stone-500">{h.collectionTitle}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
