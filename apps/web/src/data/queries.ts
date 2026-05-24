import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Recipe, RecipeCollection } from '@cookyourbooks/domain';
import { useAuth } from '../auth/AuthProvider.js';
import { useLocalDbReady, useLocalQueryEnabled, useSync } from '../local/SyncProvider.js';
import {
  getRecipeSummary,
  listAdaptations,
  type CollectionPickerOption,
  type LibraryCollectionSummary,
  type RecipeSummary,
} from '../local/repositories.js';
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

export function useCollection(collectionId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<RecipeCollection | undefined>({
    queryKey: ['collection', collectionId],
    enabled: enabled && !!collectionId,
    queryFn: () => collectionRepo(user!.id).get(collectionId!),
  });
}

export function useRecipe(collectionId: string | undefined, recipeId: string | undefined) {
  const { user } = useAuth();
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
      qc.invalidateQueries({ queryKey: ['recipe', collectionId, recipe.id] });
      // Save could have created a new adaptation (parentRecipeId set) or
      // renamed an existing one — either way, lineage lists across the
      // app are potentially stale.
      qc.invalidateQueries({ queryKey: ['adaptations'] });
      qc.invalidateQueries({ queryKey: ['recipe-summary', recipe.id] });
      void syncNow();
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
      qc.invalidateQueries({ queryKey: ['collections', user?.id] });
      qc.invalidateQueries({ queryKey: ['library-summaries', user?.id] });
      void syncNow();
    },
  });
}
