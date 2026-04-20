import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Recipe, RecipeCollection } from '@cookyourbooks/domain';
import { useAuth } from '../auth/AuthProvider.js';
import { useSync } from '../local/SyncProvider.js';
import {
  getRecipeSummary,
  listAdaptations,
  type RecipeSummary,
} from '../local/repositories.js';
import { collectionRepo, recipeRepo } from './repos.js';

export function useCollections() {
  const { user } = useAuth();
  const { status } = useSync();
  return useQuery<RecipeCollection[]>({
    queryKey: ['collections', user?.id],
    enabled: !!user && status !== 'initializing',
    queryFn: () => collectionRepo(user!.id).list(),
  });
}

export function useCollection(collectionId: string | undefined) {
  const { user } = useAuth();
  const { status } = useSync();
  return useQuery<RecipeCollection | undefined>({
    queryKey: ['collection', collectionId],
    enabled: !!user && !!collectionId && status !== 'initializing',
    queryFn: () => collectionRepo(user!.id).get(collectionId!),
  });
}

export function useRecipe(collectionId: string | undefined, recipeId: string | undefined) {
  const { user } = useAuth();
  const { status } = useSync();
  return useQuery<Recipe | undefined>({
    queryKey: ['recipe', collectionId, recipeId],
    enabled: !!user && !!collectionId && !!recipeId && status !== 'initializing',
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
      qc.invalidateQueries({ queryKey: ['collection', collectionId] });
      void syncNow();
    },
  });
}

export function useRecipeSummary(recipeId: string | undefined) {
  const { user } = useAuth();
  const { status } = useSync();
  return useQuery<RecipeSummary | undefined>({
    queryKey: ['recipe-summary', recipeId],
    enabled: !!user && !!recipeId && status !== 'initializing',
    queryFn: () => getRecipeSummary(recipeId!),
  });
}

export function useAdaptations(parentRecipeId: string | undefined) {
  const { user } = useAuth();
  const { status } = useSync();
  return useQuery<RecipeSummary[]>({
    queryKey: ['adaptations', parentRecipeId],
    enabled: !!user && !!parentRecipeId && status !== 'initializing',
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
      void syncNow();
    },
  });
}
