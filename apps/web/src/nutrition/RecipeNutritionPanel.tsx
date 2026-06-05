import { useState, useMemo } from 'react';
import {
  fmtGrams,
  fmtKcal,
  fmtMg,
  scaleToServing,
  type ServingMode,
} from '@cookyourbooks/domain';
import type { Recipe } from '@cookyourbooks/domain';
import { useRecipeNutrition } from './useRecipeNutrition.js';
import { IngredientMatchOverrideDialog } from './IngredientMatchOverrideDialog.js';

/**
 * Recipe-level nutrition panel. Renders below the steps on RecipePage.
 *
 * Two top-level numbers: total recipe nutrition + per-serving nutrition.
 *
 * Per-serving has two modes:
 *   - 'proportion': total / N. Default N comes from `recipe.servings.amount`
 *     when set, else falls back to 1.
 *   - 'weight': totals × (servingGrams / totalRecipeGrams). totalRecipeGrams
 *     defaults to the sum of resolved ingredient weights; the user can
 *     override (e.g. they weighed the finished dish).
 */
export function RecipeNutritionPanel({ recipe }: { recipe: Recipe }) {
  const { data, isLoading, error } = useRecipeNutrition(recipe);
  const [mode, setMode] = useState<'proportion' | 'weight'>('proportion');
  const [proportionServings, setProportionServings] = useState(
    () => recipe.servings?.amount ?? 1,
  );
  const [totalRecipeGrams, setTotalRecipeGrams] = useState<number | null>(null);
  const [servingGrams, setServingGrams] = useState(200);
  const [overrideIngredient, setOverrideIngredient] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const totals = data?.totals;
  // Default the "total recipe weight" input to the sum of resolved
  // ingredient grams; the user can override it when they've actually
  // weighed the finished dish (cooking loses moisture).
  const effectiveTotalGrams = totalRecipeGrams ?? totals?.total_grams ?? 0;
  const servingMode: ServingMode =
    mode === 'proportion'
      ? { kind: 'proportion', servings: proportionServings }
      : {
          kind: 'weight',
          totalRecipeGrams: effectiveTotalGrams,
          servingGrams,
        };
  const perServing = useMemo(
    () => (totals ? scaleToServing(totals, servingMode) : null),
    [totals, servingMode],
  );

  if (isLoading) {
    return (
      <section className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4 text-sm text-stone-500 dark:text-stone-400">
        Loading nutrition…
      </section>
    );
  }
  if (error) {
    return (
      <section className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-800 dark:text-red-200">
        Couldn't compute nutrition: {(error as Error).message}
      </section>
    );
  }
  if (!data || !totals || !perServing) return null;

  return (
    <section
      data-testid="recipe-nutrition-panel"
      className="space-y-4 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4"
    >
      <header className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Nutrition</h2>
        <span className="text-xs text-stone-500 dark:text-stone-400">
          Based on {totals.resolved_count} of{' '}
          {totals.resolved_count + totals.unresolved_count} ingredients
          {totals.approximate_count > 0 && (
            <> · {totals.approximate_count} approximate</>
          )}
        </span>
      </header>

      {/* ----- Totals + per-serving side-by-side on wider screens ----- */}
      <div className="grid gap-4 sm:grid-cols-2">
        <NutritionColumn
          title="Whole recipe"
          subtitle={
            totals.total_grams > 0
              ? `≈ ${Math.round(totals.total_grams)} g`
              : undefined
          }
          totals={totals}
        />
        <NutritionColumn
          title="Per serving"
          subtitle={servingSubtitle(servingMode, perServing.ratio)}
          totals={perServing}
        />
      </div>

      {/* ----- Serving controls ----- */}
      <fieldset className="border border-stone-200 dark:border-stone-700 rounded-md p-3 space-y-2">
        <legend className="px-1 text-xs font-medium text-stone-600 dark:text-stone-400">
          Serving size
        </legend>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name="serving-mode"
              checked={mode === 'proportion'}
              onChange={() => setMode('proportion')}
              data-testid="serving-mode-proportion"
            />
            <span>By yield</span>
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name="serving-mode"
              checked={mode === 'weight'}
              onChange={() => setMode('weight')}
              data-testid="serving-mode-weight"
            />
            <span>By weight</span>
          </label>
        </div>
        {mode === 'proportion' ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-stone-600 dark:text-stone-400">Recipe makes</span>
            <input
              type="number"
              min={1}
              step={1}
              value={proportionServings}
              onChange={(e) => setProportionServings(Math.max(1, Number(e.target.value)))}
              data-testid="proportion-servings"
              className="w-20 rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 text-right"
            />
            <span className="text-stone-600 dark:text-stone-400">servings</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <label className="flex items-center gap-2">
              <span className="text-stone-600 dark:text-stone-400">Recipe weight</span>
              <input
                type="number"
                min={0}
                step={10}
                value={Math.round(effectiveTotalGrams)}
                onChange={(e) => setTotalRecipeGrams(Math.max(0, Number(e.target.value)))}
                data-testid="weight-total"
                className="w-24 rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 text-right"
              />
              <span className="text-stone-600 dark:text-stone-400">g</span>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-stone-600 dark:text-stone-400">Serving</span>
              <input
                type="number"
                min={0}
                step={10}
                value={servingGrams}
                onChange={(e) => setServingGrams(Math.max(0, Number(e.target.value)))}
                data-testid="weight-serving"
                className="w-24 rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 text-right"
              />
              <span className="text-stone-600 dark:text-stone-400">g</span>
            </label>
          </div>
        )}
      </fieldset>

      {/* ----- Per-ingredient breakdown (click a row to override) ----- */}
      <details className="text-sm">
        <summary className="cursor-pointer text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100">
          Per-ingredient breakdown
        </summary>
        <table className="mt-2 w-full text-xs">
          <thead className="text-stone-500 dark:text-stone-400">
            <tr>
              <th className="text-left font-medium">Ingredient</th>
              <th className="text-right font-medium">Match</th>
              <th className="text-right font-medium">Grams</th>
              <th className="text-right font-medium">kcal</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr
                key={row.ingredientId}
                className="border-t border-stone-200 dark:border-stone-700"
                data-testid={`nutrition-row-${row.ingredientId}`}
              >
                <td className="py-1 pr-2">{row.ingredientName}</td>
                <td className="py-1 text-right">
                  {row.fact ? (
                    <button
                      type="button"
                      onClick={() =>
                        setOverrideIngredient({ id: row.ingredientId, name: row.ingredientName })
                      }
                      className="text-stone-600 dark:text-stone-400 hover:underline truncate inline-block max-w-[12rem]"
                      data-testid={`nutrition-match-${row.ingredientId}`}
                      title={row.fact.description}
                    >
                      {row.fact.description}
                    </button>
                  ) : (
                    <span className="italic text-stone-400 dark:text-stone-500">no match</span>
                  )}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {row.grams == null
                    ? '—'
                    : `${Math.round(row.grams)} g${row.approximate ? '*' : ''}`}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {row.fact?.calories_kcal != null && row.grams != null
                    ? Math.round((row.fact.calories_kcal * row.grams) / 100)
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {totals.approximate_count > 0 && (
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            * water-equivalent density used; actual gram weight may vary.
          </p>
        )}
      </details>

      {overrideIngredient && (
        <IngredientMatchOverrideDialog
          ingredientName={overrideIngredient.name}
          onClose={() => setOverrideIngredient(null)}
        />
      )}
    </section>
  );
}

function NutritionColumn({
  title,
  subtitle,
  totals,
}: {
  title: string;
  subtitle?: string;
  totals: {
    calories_kcal: number;
    protein_g: number;
    fat_g: number;
    saturated_fat_g: number;
    carbs_g: number;
    sugar_g: number;
    fiber_g: number;
    sodium_mg: number;
  };
}) {
  return (
    <div className="rounded-md border border-stone-200 dark:border-stone-700 p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="font-medium">{title}</h3>
        {subtitle && (
          <span className="text-xs text-stone-500 dark:text-stone-400">{subtitle}</span>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <Row label="Calories" value={fmtKcal(totals.calories_kcal)} bold />
        <Row label="Protein" value={fmtGrams(totals.protein_g)} />
        <Row label="Carbs" value={fmtGrams(totals.carbs_g)} />
        <Row label="—  sugar" value={fmtGrams(totals.sugar_g)} />
        <Row label="Fat" value={fmtGrams(totals.fat_g)} />
        <Row label="—  saturated" value={fmtGrams(totals.saturated_fat_g)} />
        <Row label="Fiber" value={fmtGrams(totals.fiber_g)} />
        <Row label="Sodium" value={fmtMg(totals.sodium_mg)} />
      </dl>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <>
      <dt className={`text-stone-600 dark:text-stone-400 ${bold ? 'font-semibold' : ''}`}>
        {label}
      </dt>
      <dd className={`text-right tabular-nums ${bold ? 'font-semibold' : ''}`}>{value}</dd>
    </>
  );
}

function servingSubtitle(mode: ServingMode, ratio: number): string {
  if (mode.kind === 'proportion') {
    return `1 of ${mode.servings}`;
  }
  if (mode.totalRecipeGrams <= 0 || mode.servingGrams <= 0) return 'incomplete';
  return `${Math.round(ratio * 100)}% of recipe`;
}
