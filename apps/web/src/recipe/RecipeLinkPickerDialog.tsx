import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import { LoadingState } from '../components/LoadingState.js';
import { collectionRepo } from '../data/repos.js';
import type { RecipeSearchHit } from '../local/repositories.js';

/**
 * Manually link an ingredient to the recipe it's made from. Unlike the
 * automatic same-collection matcher, a manual link may target a recipe in ANY
 * of the user's books. Searches the local library (title + ingredient names)
 * and returns the chosen recipe id to the editor, which stores it as a
 * `manual` link. No DB write happens here — the editor persists on save.
 */
export function RecipeLinkPickerDialog({
  ingredientName,
  excludeRecipeId,
  onPick,
  onClose,
}: {
  ingredientName: string;
  excludeRecipeId: string;
  onPick: (recipeId: string) => void;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const [query, setQuery] = useState(ingredientName);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const trimmed = query.trim();
  const search = useQuery<RecipeSearchHit[]>({
    queryKey: ['recipe-link-picker', user?.id, trimmed],
    enabled: Boolean(user) && trimmed.length > 0,
    queryFn: () => collectionRepo(user!.id).searchRecipes(trimmed),
  });
  const hits = (search.data ?? []).filter((h) => h.recipeId !== excludeRecipeId).slice(0, 25);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Link ${ingredientName} to a recipe`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg space-y-3 rounded-lg bg-white dark:bg-stone-900 p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold">Link “{ingredientName}” to a recipe</h2>
          <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
            Pick the recipe this ingredient is made from. It can be in any of your books.
          </p>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your recipes…"
          data-testid="link-picker-query"
          autoFocus
          className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm"
        />
        {search.isLoading && <LoadingState surface="recipe-link-picker" size="inline" />}
        {trimmed.length > 0 && search.data && (
          <ul
            data-testid="link-picker-results"
            className="max-h-72 divide-y divide-stone-200 overflow-y-auto rounded-md border border-stone-200 text-sm dark:divide-stone-700 dark:border-stone-700"
          >
            {hits.length === 0 && (
              <li className="px-3 py-2 text-stone-500 dark:text-stone-400">No matching recipes.</li>
            )}
            {hits.map((h) => (
              <li key={h.recipeId}>
                <button
                  type="button"
                  onClick={() => onPick(h.recipeId)}
                  data-testid="link-picker-pick"
                  className="block w-full px-3 py-2 text-left hover:bg-stone-100 dark:hover:bg-stone-800"
                >
                  <div className="font-medium">{h.recipeTitle}</div>
                  <div className="text-xs text-stone-500 dark:text-stone-400">
                    {h.collectionTitle}
                    {h.isPlaceholder ? ' · not imported yet' : ''}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
