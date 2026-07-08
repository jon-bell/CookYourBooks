import type { Recipe } from '@cookyourbooks/domain';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { getRecipeLinkTargets } from '../local/repositories.js';
import { useLocalQueryEnabled } from '../local/SyncProvider.js';
import type { IngredientLinkTarget } from './RecipeBody.js';

/**
 * Resolve a recipe's stored ingredient cross-reference links for display.
 *
 * Each ingredient carries a `linkedRecipeId` (materialized by the matcher at
 * save-time / backfill). This hook batches a lookup of those target recipes and
 * returns a resolver `(ingredientId) => target | undefined`. A target that no
 * longer exists locally (a hard-deleted component — Finding F) resolves to
 * undefined, so the ingredient renders as plain text rather than a dead link.
 * `dismissed` ingredients carry no `linkedRecipeId`, so they're naturally
 * excluded.
 */
export function useRecipeIngredientLinks(
  recipe: Recipe | undefined,
): (ingredientId: string) => IngredientLinkTarget | undefined {
  const enabled = useLocalQueryEnabled();

  const pairs = useMemo(() => {
    const out: Array<{ ingredientId: string; recipeId: string }> = [];
    for (const ing of recipe?.ingredients ?? []) {
      if (ing.linkedRecipeId && ing.linkSource !== 'dismissed') {
        out.push({ ingredientId: ing.id, recipeId: ing.linkedRecipeId });
      }
    }
    return out;
  }, [recipe]);

  const linkedIds = useMemo(() => [...new Set(pairs.map((p) => p.recipeId))].sort(), [pairs]);

  const { data: targets } = useQuery({
    queryKey: ['ingredient-links', ...linkedIds],
    enabled: enabled && linkedIds.length > 0,
    queryFn: () => getRecipeLinkTargets(linkedIds),
  });

  return useCallback(
    (ingredientId: string): IngredientLinkTarget | undefined => {
      if (!targets) return undefined;
      const pair = pairs.find((p) => p.ingredientId === ingredientId);
      if (!pair) return undefined;
      const t = targets.get(pair.recipeId);
      if (!t) return undefined;
      return {
        recipeId: pair.recipeId,
        collectionId: t.collectionId,
        isPlaceholder: t.isPlaceholder,
      };
    },
    [targets, pairs],
  );
}
