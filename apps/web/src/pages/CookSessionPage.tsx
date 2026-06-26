import { buildShoppingList, type Recipe } from '@cookyourbooks/domain';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { LoadingState } from '../components/LoadingState.js';
import { selectedDateLabel } from '../cooking/CalendarMonth.js';
import { mealSlotLabel } from '../cooking/format.js';
import { useCookingCalendar, useMarkCooked } from '../cooking/queries.js';
import { useRecipesByIds } from '../data/queries.js';
import type { CalendarEntry } from '../local/repositories.js';

/**
 * Cook several recipes from one day at once. Loads the day's cooking
 * events (optionally filtered to a meal slot via ?slot=), shows a combined
 * ingredient list plus each recipe's ingredients + steps, and offers
 * "Mark all as cooked" for the planned ones.
 */
export function CookSessionPage() {
  const { date } = useParams();
  const [searchParams] = useSearchParams();
  const slot = searchParams.get('slot');
  const day = date ?? '';

  const { data: allEntries = [], isLoading } = useCookingCalendar({ start: day, end: day });
  const entries = useMemo(
    () => (slot ? allEntries.filter((e) => e.mealSlot === slot) : allEntries),
    [allEntries, slot],
  );

  const recipeIds = useMemo(
    () => [...new Set(entries.map((e) => e.recipeId).filter((id): id is string => !!id))],
    [entries],
  );
  const { data: recipes = [] } = useRecipesByIds(recipeIds);
  const combined = useMemo(() => buildShoppingList(recipes), [recipes]);

  const markCooked = useMarkCooked();
  const [marking, setMarking] = useState(false);

  const plannedWithRecipe = entries.filter(
    (e) => e.status === 'PLANNED' && e.recipeId && recipes.some((r) => r.id === e.recipeId),
  );

  async function markAllCooked() {
    setMarking(true);
    try {
      for (const e of plannedWithRecipe) {
        const recipe = recipes.find((r) => r.id === e.recipeId);
        if (recipe) await markCooked.mutateAsync({ id: e.id, recipe });
      }
    } finally {
      setMarking(false);
    }
  }

  if (isLoading) return <LoadingState surface="cook-session" />;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Cook together</h1>
          <p className="text-sm text-stone-500">
            {selectedDateLabel(day)}
            {slot ? ` · ${mealSlotLabel(slot as CalendarEntry['mealSlot'])}` : ''}
          </p>
        </div>
        <Link to="/cooking" className="text-sm text-stone-600 hover:underline dark:text-stone-400">
          ← Calendar
        </Link>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-stone-500">Nothing planned or cooked for this selection.</p>
      ) : (
        <>
          {plannedWithRecipe.length > 0 && (
            <button
              type="button"
              onClick={markAllCooked}
              disabled={marking}
              className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300"
              data-testid="mark-all-cooked"
            >
              Mark all {plannedWithRecipe.length} as cooked
            </button>
          )}

          {(combined.measured.length > 0 || combined.uncountable.length > 0) && (
            <section data-testid="combined-ingredients">
              <h2 className="mb-2 text-lg font-semibold">Everything you need</h2>
              <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
                {combined.measured.map((item) => (
                  <li key={`m:${item.name}`} className="px-4 py-2 text-sm">
                    <span className="font-medium">{item.quantityText}</span> {item.name}
                  </li>
                ))}
                {combined.uncountable.map((item) => (
                  <li
                    key={`u:${item.name}`}
                    className="px-4 py-2 text-sm text-stone-600 dark:text-stone-400"
                  >
                    {item.name}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-3" data-testid="cook-session-recipes">
            <h2 className="text-lg font-semibold">Recipes ({entries.length})</h2>
            {entries.map((e) => (
              <CookSessionRecipe
                key={e.id}
                entry={e}
                recipe={recipes.find((r) => r.id === e.recipeId)}
              />
            ))}
          </section>
        </>
      )}
    </div>
  );
}

function CookSessionRecipe({
  entry,
  recipe,
}: {
  entry: CalendarEntry;
  recipe: Recipe | undefined;
}) {
  const title = entry.recipeTitle ?? entry.recipeSnapshot?.title ?? 'Recipe';
  return (
    <details
      className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-3"
      data-testid="cook-session-recipe"
      open
    >
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        {entry.mealSlot && (
          <span className="rounded-full bg-sky-100 dark:bg-sky-900/50 px-2 py-0.5 text-xs text-sky-800 dark:text-sky-200">
            {mealSlotLabel(entry.mealSlot)}
          </span>
        )}
        {entry.collectionId && entry.recipeId ? (
          <Link
            to={`/collections/${entry.collectionId}/recipes/${entry.recipeId}`}
            className="hover:underline"
          >
            {title}
          </Link>
        ) : (
          <span>{title}</span>
        )}
      </summary>
      {recipe ? (
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-1">
            <h3 className="text-sm font-semibold">Ingredients</h3>
            <ul className="mt-1 space-y-0.5 text-sm text-stone-700 dark:text-stone-300">
              {recipe.ingredients.map((ing) => (
                <li key={ing.id}>{ing.name}</li>
              ))}
            </ul>
          </div>
          <div className="md:col-span-2">
            <h3 className="text-sm font-semibold">Steps</h3>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-stone-700 dark:text-stone-300">
              {recipe.instructions.map((step) => (
                <li key={step.id}>{step.text}</li>
              ))}
            </ol>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-stone-500">
          This recipe is no longer available (it was deleted).
        </p>
      )}
    </details>
  );
}
