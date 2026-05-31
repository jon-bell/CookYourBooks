import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ingredientLookupKey, type NutritionFact } from '@cookyourbooks/domain';
import { deleteMapping, saveMapping, searchNutrition } from './api.js';

/**
 * Lets the user pick the right USDA / Open Food Facts entry for an
 * ingredient when the auto-match is wrong (e.g. "butter" → "almond
 * butter"). Persists into `ingredient_nutrition_mappings` so the
 * choice sticks across recipes that use the same ingredient string.
 */
export function IngredientMatchOverrideDialog({
  ingredientName,
  onClose,
}: {
  ingredientName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState(ingredientName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = useQuery<NutritionFact[]>({
    queryKey: ['nutrition-search', query],
    queryFn: () => searchNutrition(query, 10),
    enabled: query.trim().length > 0,
  });

  async function pick(fact: NutritionFact) {
    setError(null);
    setBusy(true);
    try {
      await saveMapping({
        ingredientKey: ingredientLookupKey(ingredientName),
        source: fact.source,
        sourceId: fact.source_id,
      });
      // Invalidate every recipe-nutrition query so the new mapping
      // takes effect immediately. Cheap — react-query refetches lazily.
      await qc.invalidateQueries({ queryKey: ['recipe-nutrition'] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setError(null);
    setBusy(true);
    try {
      await deleteMapping(ingredientLookupKey(ingredientName));
      await qc.invalidateQueries({ queryKey: ['recipe-nutrition'] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Choose nutrition data for ${ingredientName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-full max-w-xl space-y-3 rounded-lg bg-white dark:bg-stone-900 p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold">Nutrition match: {ingredientName}</h2>
          <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
            Pick the USDA / Open Food Facts entry that best matches your ingredient. Your
            choice is remembered for this ingredient string across recipes.
          </p>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search foods…"
          data-testid="nutrition-override-query"
          className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm"
          autoFocus
        />
        {search.isLoading && (
          <p className="text-sm text-stone-500 dark:text-stone-400">Searching…</p>
        )}
        {search.error && (
          <p className="text-sm text-red-700 dark:text-red-300">
            {(search.error as Error).message}
          </p>
        )}
        {search.data && (
          <ul
            data-testid="nutrition-override-results"
            className="max-h-72 overflow-y-auto rounded-md border border-stone-200 dark:border-stone-700 divide-y divide-stone-200 dark:divide-stone-700 text-sm"
          >
            {search.data.length === 0 && (
              <li className="px-3 py-2 text-stone-500 dark:text-stone-400">
                No matches. Try a different name.
              </li>
            )}
            {search.data.map((hit) => (
              <li key={`${hit.source}|${hit.source_id}`}>
                <button
                  type="button"
                  onClick={() => void pick(hit)}
                  disabled={busy}
                  data-testid={`nutrition-override-pick-${hit.source_id}`}
                  className="block w-full text-left px-3 py-2 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60"
                >
                  <div className="font-medium">{hit.description}</div>
                  <div className="text-xs text-stone-500 dark:text-stone-400">
                    {hit.brand ? `${hit.brand} · ` : ''}
                    {hit.source === 'USDA_FDC' ? 'USDA FoodData Central' : 'Open Food Facts'}
                  </div>
                  <MacroPreview hit={hit} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        )}
        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={() => void clear()}
            disabled={busy}
            className="text-xs text-stone-500 dark:text-stone-400 hover:underline disabled:opacity-60"
          >
            Reset to auto-match
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Per-100g calories + macros for one search hit. Mirrors the units the
 *  USDA / OFF data is reported in — kcal, g, mg — so the user can
 *  compare entries before committing. */
function MacroPreview({ hit }: { hit: NutritionFact }) {
  const cells: { label: string; value: string }[] = [];
  if (hit.calories_kcal != null) {
    cells.push({ label: 'kcal', value: String(Math.round(hit.calories_kcal)) });
  }
  if (hit.protein_g != null) cells.push({ label: 'protein', value: `${round1(hit.protein_g)} g` });
  if (hit.fat_g != null) cells.push({ label: 'fat', value: `${round1(hit.fat_g)} g` });
  if (hit.carbs_g != null) cells.push({ label: 'carbs', value: `${round1(hit.carbs_g)} g` });
  if (hit.fiber_g != null) cells.push({ label: 'fiber', value: `${round1(hit.fiber_g)} g` });
  if (hit.sugar_g != null) cells.push({ label: 'sugar', value: `${round1(hit.sugar_g)} g` });
  if (hit.sodium_mg != null) cells.push({ label: 'sodium', value: `${Math.round(hit.sodium_mg)} mg` });
  if (cells.length === 0) return null;
  return (
    <div className="mt-1 text-[11px] text-stone-600 dark:text-stone-400">
      <span className="text-stone-400 dark:text-stone-500">per 100 g · </span>
      {cells.map((c, i) => (
        <span key={c.label}>
          {i > 0 && <span className="text-stone-300 dark:text-stone-600"> · </span>}
          <span className="font-medium text-stone-700 dark:text-stone-300">{c.value}</span>{' '}
          <span>{c.label}</span>
        </span>
      ))}
    </div>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
