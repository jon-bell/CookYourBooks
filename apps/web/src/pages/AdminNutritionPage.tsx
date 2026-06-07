import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ingredientLookupKey, type NutritionFact } from '@cookyourbooks/domain';
import { AdminTabs, RequireAdmin } from '../admin/RequireAdmin.js';
import { supabase } from '../supabase.js';
import { searchNutrition } from '../nutrition/api.js';

/**
 * Admin nutrition surface. Three sections:
 *
 * 1. **Platform-default mappings** — `ingredient_nutrition_mappings`
 *    rows with `owner_id IS NULL`. Every signed-in user falls back to
 *    these when they don't have a personal override. CRUD here means
 *    "every user of the platform sees this match for this ingredient
 *    name unless they override it."
 *
 * 2. **Cache tweak** — pick a cached fact (`nutrition_facts_cache`)
 *    and edit the numeric fields. Useful when USDA's value is stale
 *    or when admin wants to correct a fault inherited from Open Food
 *    Facts (crowdsourced, occasionally wrong). Writes go through
 *    `admin_nutrition_upsert_fact` so the table stays service-role-
 *    write everywhere else.
 *
 * 3. **Bulk load** — paste ingredient names (one per line). The page
 *    runs them through the edge function's search, shows the auto-
 *    matched USDA / OFF top result for each, and lets admin uncheck
 *    bad matches before saving. Saving creates platform-default
 *    mappings for the checked rows.
 */
export function AdminNutritionPage() {
  return (
    <RequireAdmin>
      <div className="space-y-6">
        <AdminTabs />
        <h1 className="text-2xl font-semibold">Nutrition admin</h1>
        <PlatformMappingsSection />
        <CacheTweakSection />
        <BulkLoadSection />
      </div>
    </RequireAdmin>
  );
}

// ---------- 1. Platform default mappings ----------

interface MappingRow {
  id: string;
  ingredient_key: string;
  source: 'USDA_FDC' | 'OPEN_FOOD_FACTS';
  source_id: string;
  updated_at: string;
}

function PlatformMappingsSection() {
  const qc = useQueryClient();
  const list = useQuery<MappingRow[]>({
    queryKey: ['admin', 'nutrition', 'platform-mappings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ingredient_nutrition_mappings')
        .select('id, ingredient_key, source, source_id, updated_at')
        .is('owner_id', null)
        .order('ingredient_key', { ascending: true });
      if (error) throw error;
      return (data ?? []) as MappingRow[];
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('ingredient_nutrition_mappings')
        .delete()
        .eq('id', id)
        .is('owner_id', null);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'nutrition', 'platform-mappings'] }),
  });

  return (
    <section
      data-testid="admin-platform-mappings"
      className="space-y-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4"
    >
      <header>
        <h2 className="text-lg font-semibold">Platform default mappings</h2>
        <p className="text-xs text-stone-600 dark:text-stone-400">
          Apply to every user who hasn't set a personal override for the same ingredient
          string. Edit through bulk load below or via per-row controls here.
        </p>
      </header>
      {list.isLoading && <p className="text-sm text-stone-500">Loading…</p>}
      {list.error && (
        <p className="text-sm text-red-700">{(list.error as Error).message}</p>
      )}
      {list.data && list.data.length === 0 && (
        <p className="text-sm text-stone-500 dark:text-stone-400">
          No platform defaults yet. Use bulk load below to seed the most common ingredients.
        </p>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="divide-y divide-stone-200 dark:divide-stone-700 text-sm">
          {list.data.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between gap-2 py-1.5"
              data-testid={`platform-mapping-${m.ingredient_key}`}
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium">{m.ingredient_key}</div>
                <div className="truncate text-xs text-stone-500 dark:text-stone-400">
                  {m.source} · {m.source_id}
                </div>
              </div>
              <button
                onClick={() =>
                  confirm(`Remove the platform default for "${m.ingredient_key}"?`) &&
                  remove.mutate(m.id)
                }
                className="rounded px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- 2. Cache tweak ----------

interface CacheRow {
  source: 'USDA_FDC' | 'OPEN_FOOD_FACTS';
  source_id: string;
  description: string;
  brand: string | null;
  calories_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  saturated_fat_g: number | null;
  carbs_g: number | null;
  sugar_g: number | null;
  fiber_g: number | null;
  sodium_mg: number | null;
  portions: { unit: string; grams: number }[];
}

function CacheTweakSection() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const list = useQuery<CacheRow[]>({
    queryKey: ['admin', 'nutrition', 'cache', filter],
    queryFn: async () => {
      let q = supabase
        .from('nutrition_facts_cache')
        .select('*')
        .order('description', { ascending: true })
        .limit(50);
      if (filter.trim().length > 0) {
        q = q.ilike('description', `%${filter.trim()}%`);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as CacheRow[];
    },
  });
  const [editing, setEditing] = useState<CacheRow | null>(null);

  const save = useMutation({
    mutationFn: async (row: CacheRow) => {
      const { error } = await supabase.rpc('admin_nutrition_upsert_fact', {
        // `null` is the runtime contract (the function body coalesces);
        // gen-types renders `default null` numerics as `?: number`,
        // so collapse nulls to undefined and let the RPC default fire.
        p_source: row.source,
        p_source_id: row.source_id,
        p_description: row.description,
        p_brand: row.brand ?? undefined,
        p_calories_kcal: row.calories_kcal ?? undefined,
        p_protein_g: row.protein_g ?? undefined,
        p_fat_g: row.fat_g ?? undefined,
        p_saturated_fat_g: row.saturated_fat_g ?? undefined,
        p_carbs_g: row.carbs_g ?? undefined,
        p_sugar_g: row.sugar_g ?? undefined,
        p_fiber_g: row.fiber_g ?? undefined,
        p_sodium_mg: row.sodium_mg ?? undefined,
        p_portions: row.portions as unknown as never,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'nutrition', 'cache'] });
      qc.invalidateQueries({ queryKey: ['recipe-nutrition'] });
      setEditing(null);
    },
  });

  return (
    <section
      data-testid="admin-cache-tweak"
      className="space-y-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4"
    >
      <header>
        <h2 className="text-lg font-semibold">Cache tweak</h2>
        <p className="text-xs text-stone-600 dark:text-stone-400">
          Override the per-100g values on a cached fact. Goes through{' '}
          <code>admin_nutrition_upsert_fact</code> so the cache stays service-role-write
          for the edge function.
        </p>
      </header>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by description…"
        data-testid="cache-filter"
        className="w-full max-w-md rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm"
      />
      {list.data && list.data.length > 0 && (
        <ul className="divide-y divide-stone-200 dark:divide-stone-700 text-sm">
          {list.data.map((row) => (
            <li
              key={`${row.source}|${row.source_id}`}
              className="flex items-center justify-between gap-2 py-1.5"
            >
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium">{row.description}</div>
                <div className="truncate text-xs text-stone-500 dark:text-stone-400">
                  {row.source} · {row.source_id} ·{' '}
                  {row.calories_kcal != null ? `${Math.round(row.calories_kcal)} kcal` : '—'}
                </div>
              </div>
              <button
                onClick={() => setEditing(row)}
                data-testid={`cache-edit-${row.source_id}`}
                className="rounded px-2 py-1 text-xs hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <CacheEditDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSave={(next) => save.mutate(next)}
          saving={save.isPending}
          error={save.error ? (save.error as Error).message : null}
        />
      )}
    </section>
  );
}

function CacheEditDialog({
  row,
  onClose,
  onSave,
  saving,
  error,
}: {
  row: CacheRow;
  onClose: () => void;
  onSave: (row: CacheRow) => void;
  saving: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<CacheRow>(row);
  function field(name: keyof CacheRow, label: string, unit: string) {
    const v = draft[name] as number | null;
    return (
      <label className="flex items-center gap-2 text-sm">
        <span className="w-32 text-stone-600 dark:text-stone-400">{label}</span>
        <input
          type="number"
          step="any"
          value={v ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              [name]: e.target.value === '' ? null : Number(e.target.value),
            })
          }
          data-testid={`cache-edit-${name}`}
          className="w-32 rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 text-right"
        />
        <span className="text-xs text-stone-500 dark:text-stone-400">{unit}</span>
      </label>
    );
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${row.description}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="w-full max-w-lg space-y-3 rounded-lg bg-white dark:bg-stone-900 p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3 className="text-lg font-semibold">{row.description}</h3>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            {row.source} · {row.source_id} · values per 100 g
          </p>
        </header>
        <div className="space-y-1.5">
          {field('calories_kcal', 'Calories', 'kcal')}
          {field('protein_g', 'Protein', 'g')}
          {field('fat_g', 'Fat', 'g')}
          {field('saturated_fat_g', '— saturated', 'g')}
          {field('carbs_g', 'Carbs', 'g')}
          {field('sugar_g', '— sugar', 'g')}
          {field('fiber_g', 'Fiber', 'g')}
          {field('sodium_mg', 'Sodium', 'mg')}
        </div>
        {error && (
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(draft)}
            disabled={saving}
            data-testid="cache-edit-save"
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 3. Bulk load ----------

interface BulkPreviewRow {
  ingredientKey: string;
  match: NutritionFact | null;
  checked: boolean;
}

function BulkLoadSection() {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<BulkPreviewRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);

  const ingredients = useMemo(
    () =>
      Array.from(
        new Set(
          text
            .split('\n')
            .map((s) => ingredientLookupKey(s))
            .filter((s) => s.length > 0),
        ),
      ),
    [text],
  );

  async function onPreview() {
    setError(null);
    setBusy(true);
    setSavedCount(0);
    try {
      const out: BulkPreviewRow[] = [];
      for (const key of ingredients) {
        const hits = await searchNutrition(key, 1);
        out.push({ ingredientKey: key, match: hits[0] ?? null, checked: !!hits[0] });
      }
      setRows(out);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    if (!rows) return;
    setError(null);
    setBusy(true);
    try {
      const toInsert = rows.filter((r) => r.checked && r.match);
      if (toInsert.length === 0) {
        setError('Nothing checked — nothing to save.');
        return;
      }
      const payload = toInsert.map((r) => ({
        owner_id: null,
        ingredient_key: r.ingredientKey,
        source: r.match!.source,
        source_id: r.match!.source_id,
      }));
      const { error: upsertErr } = await supabase
        .from('ingredient_nutrition_mappings')
        .upsert(payload, { onConflict: 'owner_id,ingredient_key' });
      if (upsertErr) throw upsertErr;
      setSavedCount(toInsert.length);
      setRows(null);
      setText('');
      await qc.invalidateQueries({ queryKey: ['admin', 'nutrition', 'platform-mappings'] });
      await qc.invalidateQueries({ queryKey: ['recipe-nutrition'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="admin-bulk-load"
      className="space-y-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4"
    >
      <header>
        <h2 className="text-lg font-semibold">Bulk load platform defaults</h2>
        <p className="text-xs text-stone-600 dark:text-stone-400">
          Paste ingredient names (one per line). Preview runs each through USDA / Open Food
          Facts and shows the auto-matched top result. Uncheck any wrong matches before
          saving — those won't be written.
        </p>
      </header>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'flour\nbutter\nsugar\negg\nmilk'}
        rows={6}
        data-testid="bulk-load-textarea"
        className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-2 font-mono text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void onPreview()}
          disabled={busy || ingredients.length === 0}
          data-testid="bulk-load-preview"
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 disabled:opacity-60"
        >
          {busy ? 'Searching…' : `Preview ${ingredients.length || ''} matches`}
        </button>
        {rows && (
          <button
            onClick={() => void onSave()}
            disabled={busy}
            data-testid="bulk-load-save"
            className="rounded-md bg-emerald-700 dark:bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            Save checked → platform defaults
          </button>
        )}
      </div>
      {error && (
        <p className="text-sm text-red-700 dark:text-red-300" data-testid="bulk-load-error">
          {error}
        </p>
      )}
      {savedCount > 0 && (
        <p className="text-sm text-emerald-700 dark:text-emerald-300">
          Saved {savedCount} platform default{savedCount === 1 ? '' : 's'}.
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul
          data-testid="bulk-load-preview-list"
          className="divide-y divide-stone-200 dark:divide-stone-700 rounded-md border border-stone-200 dark:border-stone-700 text-sm"
        >
          {rows.map((row, i) => (
            <li key={row.ingredientKey} className="flex items-center gap-2 px-3 py-2">
              <input
                type="checkbox"
                checked={row.checked}
                disabled={!row.match}
                onChange={(e) =>
                  setRows(
                    (cur) =>
                      cur?.map((r, j) => (i === j ? { ...r, checked: e.target.checked } : r)) ??
                      null,
                  )
                }
                data-testid={`bulk-load-check-${row.ingredientKey}`}
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium">{row.ingredientKey}</div>
                <div className="truncate text-xs text-stone-500 dark:text-stone-400">
                  {row.match
                    ? `${row.match.description} (${row.match.source})`
                    : 'no match found'}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
