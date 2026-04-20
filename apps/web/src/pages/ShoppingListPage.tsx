import { useMemo, useState } from 'react';
import { buildShoppingList } from '@cookyourbooks/domain';
import { useCollections } from '../data/queries.js';

export function ShoppingListPage() {
  const { data: collections = [], isLoading } = useCollections();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(() => loadChecked());

  const list = useMemo(() => {
    const recipes = collections.flatMap((c) => c.recipes).filter((r) => selected.has(r.id));
    return buildShoppingList(recipes);
  }, [collections, selected]);

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

  if (isLoading) return <p className="text-stone-500">Loading…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Shopping list</h1>
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-stone-600">Include recipes</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
          {collections.flatMap((c) =>
            c.recipes.map((r) => (
              <label
                key={r.id}
                className="flex cursor-pointer items-center gap-2 rounded border border-stone-200 bg-white px-3 py-2 text-sm hover:border-stone-400"
              >
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggleSelect(r.id)}
                />
                <span className="font-medium">{r.title}</span>
                <span className="ml-auto text-xs text-stone-500">{c.title}</span>
              </label>
            )),
          )}
        </div>
      </section>

      {selected.size > 0 && (
        <section className="space-y-4">
          {list.measured.length > 0 && (
            <div>
              <h2 className="mb-2 text-lg font-semibold">Groceries</h2>
              <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
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
                        <span className="text-xs text-stone-500">
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
              <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
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
    return new Set(JSON.parse(raw));
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
