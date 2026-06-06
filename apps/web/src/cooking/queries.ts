import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  logCook,
  planCook,
  snapshotOfRecipe,
  type MealSlot,
  type OccasionCategory,
  type Recipe,
  type RecipeAdjustment,
} from '@cookyourbooks/domain';
import { useAuth } from '../auth/AuthProvider.js';
import { useLocalQueryEnabled, useSync } from '../local/SyncProvider.js';
import {
  searchRecipesByTags,
  type CalendarEntry,
  type CookingEventRecord,
  type RecentlyViewedEntry,
  type RecipeSearchHit,
} from '../local/repositories.js';
import { cookingEventRepo, recipeTagRepo, recipeViewRepo } from '../data/repos.js';
import { deleteCookingPhotos } from './photos.js';

// ---------- reads ----------

export function useCookingEvents(recipeId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<CookingEventRecord[]>({
    queryKey: ['cooking', 'events', user?.id, recipeId],
    enabled: enabled && !!recipeId,
    queryFn: () => cookingEventRepo(user!.id).listForRecipe(recipeId!),
  });
}

export function useCookingCalendar(range: { start: string; end: string }) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<CalendarEntry[]>({
    queryKey: ['cooking', 'calendar', user?.id, range.start, range.end],
    enabled: enabled && !!range.start && !!range.end,
    queryFn: () => cookingEventRepo(user!.id).listCalendarEntries(range.start, range.end),
  });
}

/** Distinct recipe ids with a PLANNED cook in [start, end] — for shopping. */
export function useScheduledRecipeIds(range: { start: string; end: string }) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<string[]>({
    queryKey: ['cooking', 'scheduled', user?.id, range.start, range.end],
    enabled: enabled && !!range.start && !!range.end,
    queryFn: async () => {
      const events = await cookingEventRepo(user!.id).listInDateRange(range.start, range.end);
      const ids = new Set<string>();
      for (const e of events) {
        if (e.status === 'PLANNED' && e.recipeId) ids.add(e.recipeId);
      }
      return [...ids];
    },
  });
}

/** Free-form occasions previously used — suggestions for the autocomplete. */
export function useOccasionSuggestions() {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<string[]>({
    queryKey: ['cooking', 'occasions', user?.id],
    enabled,
    queryFn: () => cookingEventRepo(user!.id).listOccasions(),
  });
}

export function useRecipeTags(recipeId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<string[]>({
    queryKey: ['tags', 'recipe', user?.id, recipeId],
    enabled: enabled && !!recipeId,
    queryFn: async () =>
      (await recipeTagRepo(user!.id).listForRecipe(recipeId!)).map((t) => t.label),
  });
}

export function useAllTags() {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<string[]>({
    queryKey: ['tags', 'all', user?.id],
    enabled,
    queryFn: () => recipeTagRepo(user!.id).listAllLabels(),
  });
}

export function useRecipesByTag(labels: string[]) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  const key = [...labels].sort();
  return useQuery<RecipeSearchHit[]>({
    queryKey: ['tags', 'recipes', user?.id, key],
    enabled: enabled && labels.length > 0,
    queryFn: () => searchRecipesByTags(user!.id, labels),
  });
}

export function useRecentlyViewed(limit = 50) {
  const enabled = useLocalQueryEnabled();
  return useQuery<RecentlyViewedEntry[]>({
    queryKey: ['recently-viewed', limit],
    enabled,
    queryFn: () => recipeViewRepo().listRecentlyViewed(limit),
  });
}

// ---------- mutations ----------

function useInvalidateCooking() {
  const qc = useQueryClient();
  const { syncNow } = useSync();
  return () => {
    qc.invalidateQueries({
      predicate: (q) => q.queryKey[0] === 'cooking',
    });
    void syncNow();
  };
}

export interface CookFormInput {
  /** Pre-minted id (so photos can be uploaded to the event's folder first). */
  id?: string;
  recipe: Recipe;
  date: string; // 'YYYY-MM-DD'
  occasionCategory?: OccasionCategory;
  mealSlot?: MealSlot;
  occasionNote?: string;
  notes?: string;
  adjustments?: RecipeAdjustment[];
  photoPaths?: string[];
}

/** "I made this" — a COOKED event with a durable recipe snapshot. */
export function useLogCook() {
  const { user } = useAuth();
  const invalidate = useInvalidateCooking();
  return useMutation({
    mutationFn: (input: CookFormInput) =>
      cookingEventRepo(user!.id).save(
        logCook({
          id: input.id,
          recipeId: input.recipe.id,
          eventDate: input.date,
          occasionCategory: input.occasionCategory,
          mealSlot: input.mealSlot,
          occasionNote: input.occasionNote,
          notes: input.notes,
          adjustments: input.adjustments,
          photoPaths: input.photoPaths,
          snapshot: snapshotOfRecipe(input.recipe),
        }),
      ),
    onSuccess: invalidate,
  });
}

/** "Make on <date>" — a PLANNED event (no snapshot until cooked). */
export function useScheduleCook() {
  const { user } = useAuth();
  const invalidate = useInvalidateCooking();
  return useMutation({
    mutationFn: (input: CookFormInput) =>
      cookingEventRepo(user!.id).save(
        planCook({
          id: input.id,
          recipeId: input.recipe.id,
          eventDate: input.date,
          occasionCategory: input.occasionCategory,
          mealSlot: input.mealSlot,
          occasionNote: input.occasionNote,
          notes: input.notes,
          adjustments: input.adjustments,
          photoPaths: input.photoPaths,
        }),
      ),
    onSuccess: invalidate,
  });
}

/** Mark a PLANNED event COOKED, capturing the recipe snapshot now. */
export function useMarkCooked() {
  const { user } = useAuth();
  const invalidate = useInvalidateCooking();
  return useMutation({
    mutationFn: ({ id, recipe }: { id: string; recipe: Recipe }) =>
      cookingEventRepo(user!.id).markCooked(id, snapshotOfRecipe(recipe)),
    onSuccess: invalidate,
  });
}

export function useDeleteCook() {
  const { user } = useAuth();
  const invalidate = useInvalidateCooking();
  return useMutation({
    mutationFn: async ({ id, photoPaths }: { id: string; photoPaths?: readonly string[] }) => {
      // Best-effort storage cleanup so deleted entries don't orphan their
      // photos. Failures here shouldn't block the entry deletion.
      if (photoPaths && photoPaths.length > 0) {
        try {
          await deleteCookingPhotos(photoPaths);
        } catch {
          /* ignore — the row delete is what matters */
        }
      }
      await cookingEventRepo(user!.id).delete(id);
    },
    onSuccess: invalidate,
  });
}

// ---------- tag mutations ----------

function useInvalidateTags() {
  const qc = useQueryClient();
  const { syncNow } = useSync();
  return () => {
    qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'tags' });
    void syncNow();
  };
}

export function useAddRecipeTag() {
  const { user } = useAuth();
  const invalidate = useInvalidateTags();
  return useMutation({
    mutationFn: ({ recipeId, label }: { recipeId: string; label: string }) =>
      recipeTagRepo(user!.id).addTag(recipeId, label),
    onSuccess: invalidate,
  });
}

export function useRemoveRecipeTag() {
  const { user } = useAuth();
  const invalidate = useInvalidateTags();
  return useMutation({
    mutationFn: ({ recipeId, label }: { recipeId: string; label: string }) =>
      recipeTagRepo(user!.id).removeTag(recipeId, label),
    onSuccess: invalidate,
  });
}

// ---------- view history (local-only; no sync) ----------

export function useRecordRecipeView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ recipeId, source }: { recipeId: string; source?: string }) =>
      recipeViewRepo().recordView(recipeId, source),
    onSuccess: () => {
      // Local-only: refresh the recently-viewed list, no syncNow().
      qc.invalidateQueries({ queryKey: ['recently-viewed'] });
    },
  });
}
