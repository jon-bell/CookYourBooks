import type { Recipe, RecipeCollection } from '@cookyourbooks/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../auth/AuthProvider.js';
import {
  type CollectionPickerOption,
  type CollectionRecipeSummary,
  type GalleryRecipeSummary,
  getRecipesByIds,
  getRecipeSummaries,
  getRecipeSummary,
  type LibraryCollectionSummary,
  listAdaptations,
  type RecipeSearchHit,
  type RecipeSummary,
} from '../local/repositories.js';
import { useLocalDbReady, useLocalQueryEnabled, useSync } from '../local/SyncProvider.js';
import { embedAndPushRecipe } from '../search/saveHook.js';
import { collectionRepo, recipeRepo } from './repos.js';

export function useCollections() {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<RecipeCollection[]>({
    queryKey: ['collections', user?.id],
    enabled,
    queryFn: () => collectionRepo(user!.id).list(),
  });
}

/** Library grid — metadata + recipe counts only (no full hydration). */
export function useLibrarySummaries() {
  const { user } = useAuth();
  const enabled = useLocalDbReady();
  return useQuery<LibraryCollectionSummary[]>({
    queryKey: ['library-summaries', user?.id],
    enabled,
    queryFn: () => collectionRepo(user!.id).listLibrarySummaries(),
  });
}

/** Library-wide cover gallery — every non-empty recipe (own + household-shared),
 *  view-sorted. Lightweight rows, no full hydration. */
export function useGalleryRecipes() {
  const { user } = useAuth();
  const enabled = useLocalDbReady();
  return useQuery<GalleryRecipeSummary[]>({
    queryKey: ['gallery-recipes', user?.id],
    enabled,
    queryFn: () => collectionRepo(user!.id).listGalleryRecipes(),
  });
}

/** Cookbook dropdowns on import flows — id/title only, no full hydration. */
export function useCollectionPickerOptions() {
  const { user } = useAuth();
  const enabled = useLocalDbReady();
  return useQuery<CollectionPickerOption[]>({
    queryKey: ['collection-picker', user?.id],
    enabled,
    queryFn: () => collectionRepo(user!.id).listPickerOptions(),
  });
}

/**
 * SQL-backed library search (title + ingredient name). Returns lightweight
 * hits — no full-library hydration. An empty query lists every recipe, so
 * the shopping-list selector reuses it.
 */
export function useRecipeSearch(query: string) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<RecipeSearchHit[]>({
    queryKey: ['recipe-search', user?.id, query],
    enabled,
    queryFn: () => collectionRepo(user!.id).searchRecipes(query),
  });
}

/** Fully hydrate a specific set of recipes (e.g. the shopping-list
 *  selection) without materializing the rest of the library. */
export function useRecipesByIds(ids: readonly string[]) {
  const enabled = useLocalQueryEnabled();
  // Stable, order-independent key so selecting {a,b} and {b,a} share a cache
  // entry and re-selecting the same set doesn't refetch.
  const key = [...ids].sort();
  return useQuery<Recipe[]>({
    queryKey: ['recipes-by-ids', key],
    enabled: enabled && ids.length > 0,
    queryFn: () => getRecipesByIds(ids),
  });
}

export function useCollection(collectionId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<RecipeCollection | undefined>({
    queryKey: ['collection', collectionId],
    enabled: enabled && !!collectionId,
    queryFn: () => collectionRepo(user!.id).get(collectionId!),
  });
}

/**
 * Collection metadata only (recipes: []) for the collection page header +
 * its publish/cover/share controls. Lightweight: no per-recipe hydration.
 * The recipe cards come from {@link useCollectionRecipeSummaries}.
 */
export function useCollectionMeta(collectionId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<RecipeCollection | undefined>({
    queryKey: ['collection-meta', collectionId],
    enabled: enabled && !!collectionId,
    queryFn: () => collectionRepo(user!.id).getMeta(collectionId!),
  });
}

/** Lightweight per-recipe cards for the collection browse view — title,
 *  cover, page, star, child counts, ingredient names. No full hydration. */
export function useCollectionRecipeSummaries(collectionId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<CollectionRecipeSummary[]>({
    queryKey: ['collection-recipes', collectionId],
    enabled: enabled && !!collectionId,
    queryFn: () => collectionRepo(user!.id).listCollectionRecipeSummaries(collectionId!),
  });
}

export function useRecipe(collectionId: string | undefined, recipeId: string | undefined) {
  const enabled = useLocalQueryEnabled();
  return useQuery<Recipe | undefined>({
    queryKey: ['recipe', collectionId, recipeId],
    enabled: enabled && !!collectionId && !!recipeId,
    queryFn: () => recipeRepo(collectionId!).get(recipeId!),
  });
}

export function useSaveCollection() {
  const { user } = useAuth();
  const { syncNow } = useSync();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: RecipeCollection) => collectionRepo(user!.id).save(c),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['collections', user?.id] });
      qc.invalidateQueries({ queryKey: ['library-summaries', user?.id] });
      qc.invalidateQueries({ queryKey: ['collection-picker', user?.id] });
      qc.invalidateQueries({ queryKey: ['collection', variables.id] });
      qc.invalidateQueries({ queryKey: ['collection-meta', variables.id] });
      void syncNow();
    },
  });
}

export function useDeleteCollection() {
  const { user } = useAuth();
  const { syncNow } = useSync();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => collectionRepo(user!.id).delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collections', user?.id] });
      qc.invalidateQueries({ queryKey: ['library-summaries', user?.id] });
      qc.invalidateQueries({ queryKey: ['collection-picker', user?.id] });
      void syncNow();
    },
  });
}

export function useSaveRecipe(collectionId: string) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { syncNow } = useSync();
  return useMutation({
    mutationFn: (recipe: Recipe) => recipeRepo(collectionId).save(recipe),
    onSuccess: (_data, recipe) => {
      qc.invalidateQueries({ queryKey: ['collections', user?.id] });
      qc.invalidateQueries({ queryKey: ['library-summaries', user?.id] });
      qc.invalidateQueries({ queryKey: ['collection', collectionId] });
      qc.invalidateQueries({ queryKey: ['collection-recipes', collectionId] });
      qc.invalidateQueries({ queryKey: ['recipe', collectionId, recipe.id] });
      // Save could have created a new adaptation (parentRecipeId set) or
      // renamed an existing one — either way, lineage lists across the
      // app are potentially stale.
      qc.invalidateQueries({ queryKey: ['adaptations'] });
      qc.invalidateQueries({ queryKey: ['recipe-summary', recipe.id] });
      qc.invalidateQueries({ queryKey: ['recipe-search'] });
      qc.invalidateQueries({ queryKey: ['recipes-by-ids'] });
      void syncNow();
      // Fire-and-forget: compute the embedding locally and queue an
      // upsert to pgvector. Heavy on the first call (~30 MB model
      // download) so deliberately not awaited — search remains usable
      // via the substring fallback in the meantime.
      void embedAndPushRecipe(recipe).catch(() => {
        // The worker will compute the canonical vector regardless; a
        // failed local short-circuit is recoverable.
      });
    },
  });
}

export function useDeleteRecipe(collectionId: string) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { syncNow } = useSync();
  return useMutation({
    mutationFn: (recipeId: string) => recipeRepo(collectionId).delete(recipeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collections', user?.id] });
      qc.invalidateQueries({ queryKey: ['library-summaries', user?.id] });
      qc.invalidateQueries({ queryKey: ['collection', collectionId] });
      qc.invalidateQueries({ queryKey: ['collection-recipes', collectionId] });
      qc.invalidateQueries({ queryKey: ['recipe-search'] });
      qc.invalidateQueries({ queryKey: ['recipes-by-ids'] });
      void syncNow();
    },
  });
}

/**
 * Flip a single recipe's `starred` flag (the Speed-Importer queue marker).
 * Reads the recipe via the local repo, constructs the new immutable instance,
 * and saves through the same path as {@link useSaveRecipe} (including the
 * embedding push), so the row's full graph is preserved. Invalidates the same
 * set as a recipe save plus the collection's lightweight card list.
 */
export function useToggleRecipeStar(collectionId: string) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { syncNow } = useSync();
  return useMutation({
    mutationFn: async (recipeId: string) => {
      const recipe = await recipeRepo(collectionId).get(recipeId);
      if (!recipe) return undefined;
      const next: Recipe = { ...recipe, starred: !(recipe.starred === true) };
      await recipeRepo(collectionId).save(next);
      return next;
    },
    onSuccess: (recipe) => {
      qc.invalidateQueries({ queryKey: ['collections', user?.id] });
      qc.invalidateQueries({ queryKey: ['library-summaries', user?.id] });
      qc.invalidateQueries({ queryKey: ['collection', collectionId] });
      qc.invalidateQueries({ queryKey: ['collection-recipes', collectionId] });
      qc.invalidateQueries({ queryKey: ['recipe-search'] });
      qc.invalidateQueries({ queryKey: ['recipes-by-ids'] });
      if (recipe) {
        qc.invalidateQueries({ queryKey: ['recipe', collectionId, recipe.id] });
        qc.invalidateQueries({ queryKey: ['recipe-summary', recipe.id] });
        void embedAndPushRecipe(recipe).catch(() => {
          // Recoverable: the worker recomputes the canonical vector.
        });
      }
      void syncNow();
    },
  });
}

export function useRecipeSummary(recipeId: string | undefined) {
  const enabled = useLocalQueryEnabled();
  return useQuery<RecipeSummary | undefined>({
    queryKey: ['recipe-summary', recipeId],
    enabled: enabled && !!recipeId,
    queryFn: () => getRecipeSummary(recipeId!),
  });
}

/**
 * Batched recipe summaries (title + collection) for a set of ids, returned as a
 * Map for O(1) lookup. Used by the Activity feed to turn a job's recipe id into
 * a titled deep-link; ids not in the local cache simply won't be in the map.
 */
export function useRecipeSummaries(ids: readonly string[]) {
  const enabled = useLocalQueryEnabled();
  const key = [...new Set(ids)].sort();
  return useQuery<Map<string, RecipeSummary>>({
    queryKey: ['recipe-summaries', key],
    enabled: enabled && key.length > 0,
    queryFn: async () => new Map((await getRecipeSummaries(key)).map((s) => [s.id, s])),
  });
}

export function useAdaptations(parentRecipeId: string | undefined) {
  const enabled = useLocalQueryEnabled();
  return useQuery<RecipeSummary[]>({
    queryKey: ['adaptations', parentRecipeId],
    enabled: enabled && !!parentRecipeId,
    queryFn: () => listAdaptations(parentRecipeId!),
  });
}

export function useReorderRecipes(collectionId: string) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { syncNow } = useSync();
  return useMutation({
    mutationFn: (orderedIds: string[]) =>
      collectionRepo(user!.id).reorderRecipes(collectionId, orderedIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection', collectionId] });
      qc.invalidateQueries({ queryKey: ['collection-recipes', collectionId] });
      qc.invalidateQueries({ queryKey: ['collections', user?.id] });
      qc.invalidateQueries({ queryKey: ['library-summaries', user?.id] });
      void syncNow();
    },
  });
}
