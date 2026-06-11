import { buildShoppingList } from '@cookyourbooks/domain';
import { useMemo, useState } from 'react';

import { LoadingState } from '../components/LoadingState.js';
import { addDaysISO, todayISO } from '../cooking/dateGrid.js';
import { useScheduledRecipeIds } from '../cooking/queries.js';
import { useRecipesByIds, useRecipeSearch } from '../data/queries.js';
import { PantrySection } from './PantrySection.js';

export function ShoppingListPage() {
  // Lightweight selector list (no full-library hydration). Only the
  // recipes the user actually selects get hydrated, on demand.
  const { data: hits = [], isLoading } = useRecipeSearch('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(() => loadChecked());

  // "Shop for what's scheduled" — pull recipes PLANNED in a date range
  // and merge them into the selection, feeding the existing builder.
  const [rangeStart, setRangeStart] = useState(todayISO());
  const [rangeEnd, setRangeEnd] = useState(addDaysISO(todayISO(), 7));
  const { data: scheduledIds = [] } = useScheduledRecipeIds({
    start: rangeStart,
    end: rangeEnd,
  });

  const selectedIds = useMemo(() => [...selected], [selected]);
  const { data: selectedRecipes = [] } = useRecipesByIds(selectedIds);
  const list = useMemo(() => buildShoppingList(selectedRecipes), [selectedRecipes]);

  function toggleSelect(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleCheck(key: string) {
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveChecked(next);
      return next;
    });
  }

  if (isLoading) return <LoadingState surface="shopping" />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Shopping list</h1>

      <section
        className="space-y-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4"
        data-testid="shop-scheduled"
      >
        <h2 className="text-sm font-medium text-stone-600 dark:text-stone-400">
          Shop for what's scheduled
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-xs text-stone-500">From</span>
            <input
              type="date"
              value={rangeStart}
              onChange={(e) => setRangeStart(e.target.value)}
              className="rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-2 py-1"
              data-testid="shop-range-start"
            />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-stone-500">To</span>
            <input
              type="date"
              value={rangeEnd}
              onChange={(e) => setRangeEnd(e.target.value)}
              className="rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-2 py-1"
              data-testid="shop-range-end"
            />
          </label>
          <button
            type="button"
            disabled={scheduledIds.length === 0}
            onClick={() => setSelected((cur) => new Set([...cur, ...scheduledIds]))}
            className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300"
            data-testid="add-scheduled"
          >
            Add scheduled recipes
          </button>
          <span className="text-xs text-stone-500">
            {scheduledIds.length} recipe{scheduledIds.length === 1 ? '' : 's'} scheduled in this
            range
          </span>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-stone-600 dark:text-stone-400">Include recipes</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
          {hits.map((h) => (
            <label
              key={h.recipeId}
              className="flex cursor-pointer items-center gap-2 rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3 py-2 text-sm hover:border-stone-400"
            >
              <input
                type="checkbox"
                checked={selected.has(h.recipeId)}
                onChange={() => toggleSelect(h.recipeId)}
              />
              <span className="font-medium">{h.recipeTitle}</span>
              <span className="ml-auto text-xs text-stone-500 dark:text-stone-400">
                {h.collectionTitle}
              </span>
            </label>
          ))}
        </div>
      </section>

      <PantrySection />

      {selected.size > 0 && (
        <section className="space-y-4">
          {list.measured.length > 0 && (
            <div>
              <h2 className="mb-2 text-lg font-semibold">Groceries</h2>
              <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
                {list.measured.map((item) => {
                  const key = `m:${item.name}:${item.quantityText}`;
                  const isChecked = checked.has(key);
                  return (
                    <li key={key} className="flex items-center gap-3 px-4 py-2">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleCheck(key)}
                      />
                      <span className={`flex-1 ${isChecked ? 'text-stone-400 line-through' : ''}`}>
                        <span className="font-medium">{item.quantityText}</span> {item.name}
                      </span>
                      {item.aggregated && (
                        <span className="text-xs text-stone-500 dark:text-stone-400">
                          {item.sourceRecipeIds.length} recipes
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {list.uncountable.length > 0 && (
            <div>
              <h2 className="mb-2 text-lg font-semibold">To taste</h2>
              <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
                {list.uncountable.map((item) => {
                  const key = `v:${item.name}`;
                  const isChecked = checked.has(key);
                  return (
                    <li key={key} className="flex items-center gap-3 px-4 py-2">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleCheck(key)}
                      />
                      <span className={`flex-1 ${isChecked ? 'text-stone-400 line-through' : ''}`}>
                        {item.name}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

const STORAGE_KEY = 'cookyourbooks.shopping.checked.v1';

function loadChecked(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function saveChecked(s: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}
