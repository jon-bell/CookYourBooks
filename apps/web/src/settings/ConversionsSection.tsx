import { canonicalUnitName, Units } from '@cookyourbooks/domain';
import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import { LoadingState } from '../components/LoadingState.js';
import {
  type GlobalConversionRule,
  type HouseConversionRule,
  useDeleteHouseConversionRule,
  useGlobalConversionRules,
  useHouseConversionRules,
  useUpsertHouseConversionRule,
} from '../data/conversions.js';
import { getLocalDb } from '../local/db.js';

const UNIT_OPTIONS = Object.values(Units)
  // Taste-tier units are meaningless to convert to/from. Exclude them
  // from the form so users don't accidentally store nonsense rules.
  .filter((u) => u.dimension !== 'TASTE')
  .map((u) => u.name);

interface DraftState {
  id?: string;
  fromAmount: string;
  fromUnit: string;
  ingredient: string;
  toAmount: string;
  toUnit: string;
  notes: string;
}

const EMPTY_DRAFT: DraftState = {
  fromAmount: '1',
  fromUnit: 'piece',
  ingredient: '',
  toAmount: '',
  toUnit: 'gram',
  notes: '',
};

export function ConversionsSection() {
  const { user } = useAuth();
  const { data: houseRules = [], isLoading: houseLoading } = useHouseConversionRules();
  const { data: globalRules = [], isLoading: globalLoading } = useGlobalConversionRules();
  const upsert = useUpsertHouseConversionRule();
  const remove = useDeleteHouseConversionRule();
  const distinctIngredients = useDistinctIngredientNames();

  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  // Build the override-vs-add lookup: a tuple key (from, to, ingredient)
  // maps to whichever HOUSE or GLOBAL row currently wins. Renderer
  // walks both lists and consults this map per row.
  const ruleKey = (fromUnit: string, toUnit: string, ingredient: string | null) =>
    `${fromUnit}::${toUnit}::${ingredient ?? ''}`;
  const houseByKey = useMemo(() => {
    const m = new Map<string, HouseConversionRule>();
    for (const r of houseRules) m.set(ruleKey(r.fromUnit, r.toUnit, r.ingredientName), r);
    return m;
  }, [houseRules]);

  function ingredientOrNull(): string | null {
    const trimmed = draft.ingredient.trim().toLowerCase();
    return trimmed === '' ? null : trimmed;
  }

  function startEdit(rule: HouseConversionRule) {
    setDraft({
      id: rule.id,
      fromAmount: '1',
      fromUnit: rule.fromUnit,
      ingredient: rule.ingredientName ?? '',
      toAmount: String(rule.factor),
      toUnit: rule.toUnit,
      notes: rule.notes ?? '',
    });
    setAdvanced(false);
    setError(null);
  }

  function startOverride(rule: GlobalConversionRule) {
    setDraft({
      id: undefined,
      fromAmount: '1',
      fromUnit: rule.fromUnit,
      ingredient: rule.ingredientName ?? '',
      toAmount: String(rule.factor),
      toUnit: rule.toUnit,
      // The global rule's notes are admin-authored; don't carry them
      // into the user's HOUSE override — they can add their own.
      notes: '',
    });
    setAdvanced(false);
    setError(null);
  }

  function cancelEdit() {
    setDraft(EMPTY_DRAFT);
    setError(null);
  }

  async function save() {
    setError(null);
    const fromAmount = Number(draft.fromAmount);
    const toAmount = Number(draft.toAmount);
    if (!Number.isFinite(fromAmount) || fromAmount <= 0) {
      setError('Left-hand amount must be a positive number.');
      return;
    }
    if (!Number.isFinite(toAmount) || toAmount <= 0) {
      setError('Right-hand amount must be a positive number.');
      return;
    }
    const fromUnit = canonicalUnitName(draft.fromUnit);
    const toUnit = canonicalUnitName(draft.toUnit);
    if (!fromUnit || !toUnit) {
      setError('Pick units for both sides.');
      return;
    }
    if (fromUnit === toUnit && !ingredientOrNull()) {
      setError('A generic rule converting a unit to itself is a no-op.');
      return;
    }
    try {
      // Look for an existing HOUSE rule with the same key; if found,
      // treat as an update regardless of the draft.id state (covers
      // the common "I added the same rule twice" case).
      const existingId =
        draft.id ?? houseByKey.get(ruleKey(fromUnit, toUnit, ingredientOrNull()))?.id;
      await upsert.mutateAsync({
        id: existingId,
        fromUnit,
        toUnit,
        factor: toAmount / fromAmount,
        ingredientName: ingredientOrNull(),
        notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
      });
      setDraft(EMPTY_DRAFT);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function resetToGlobal(rule: HouseConversionRule) {
    if (!confirm('Remove your override and fall back to the global default?')) return;
    try {
      await remove.mutateAsync(rule.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!user) return null;

  return (
    <section className="space-y-4 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-5">
      <div>
        <h2 className="text-lg font-semibold">House conversions</h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Personal equivalents that override the global defaults — e.g. "1 whole onion ≈ 240 g".
          Used everywhere the app converts a recipe quantity from one unit to another.
        </p>
      </div>

      <form
        className="space-y-2 rounded-md border border-stone-200 dark:border-stone-700 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {advanced ? (
            <input
              type="number"
              min={0}
              step="any"
              value={draft.fromAmount}
              onChange={(e) => setDraft((d) => ({ ...d, fromAmount: e.target.value }))}
              className="w-20 rounded border border-stone-300 dark:border-stone-600 px-2 py-1"
              aria-label="Left-hand amount"
            />
          ) : (
            <span className="font-semibold">1</span>
          )}
          <select
            value={draft.fromUnit}
            onChange={(e) => setDraft((d) => ({ ...d, fromUnit: e.target.value }))}
            className="rounded border border-stone-300 dark:border-stone-600 px-2 py-1"
            aria-label="From unit"
          >
            {UNIT_OPTIONS.map((u) => (
              <option key={u} value={u}>
                {u === 'piece' ? 'piece (whole)' : u}
              </option>
            ))}
          </select>
          <input
            type="text"
            list="conversion-ingredient-options"
            value={draft.ingredient}
            onChange={(e) => setDraft((d) => ({ ...d, ingredient: e.target.value }))}
            placeholder="(any ingredient)"
            className="min-w-[10rem] flex-1 rounded border border-stone-300 dark:border-stone-600 px-2 py-1"
            aria-label="Ingredient"
          />
          <span className="text-stone-500 dark:text-stone-400">≈</span>
          <input
            type="number"
            min={0}
            step="any"
            value={draft.toAmount}
            onChange={(e) => setDraft((d) => ({ ...d, toAmount: e.target.value }))}
            className="w-24 rounded border border-stone-300 dark:border-stone-600 px-2 py-1"
            aria-label="Right-hand amount"
            required
          />
          <select
            value={draft.toUnit}
            onChange={(e) => setDraft((d) => ({ ...d, toUnit: e.target.value }))}
            className="rounded border border-stone-300 dark:border-stone-600 px-2 py-1"
            aria-label="To unit"
          >
            {UNIT_OPTIONS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <datalist id="conversion-ingredient-options">
            {distinctIngredients.map((name) => (
              <option key={name} value={name} />
            ))}
            {globalRules
              .map((r) => r.ingredientName)
              .filter((n): n is string => !!n)
              .map((n) => (
                <option key={`g:${n}`} value={n} />
              ))}
          </datalist>
          <button
            type="submit"
            disabled={upsert.isPending || !draft.toAmount}
            className="ml-auto rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
          >
            {draft.id ? 'Update' : 'Save'}
          </button>
          {(draft.id !== undefined || draft.toAmount !== '') && (
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-md px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              Cancel
            </button>
          )}
        </div>
        <input
          type="text"
          value={draft.notes}
          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
          placeholder="Note (optional) — e.g. weighed 2026-05, my 8oz cup, etc."
          maxLength={500}
          className="w-full rounded border border-stone-300 dark:border-stone-600 px-2 py-1 text-sm"
          aria-label="Note"
        />
        <div className="flex items-center justify-between text-xs">
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="text-stone-500 dark:text-stone-400 underline-offset-2 hover:underline"
          >
            {advanced ? '— hide advanced' : '+ advanced (custom left-hand amount)'}
          </button>
          {error && <span className="text-red-700 dark:text-red-300">{error}</span>}
        </div>
      </form>

      {(houseLoading || globalLoading) && houseRules.length === 0 && globalRules.length === 0 ? (
        <LoadingState surface="settings-conversions" size="inline" />
      ) : (
        <RuleList
          houseRules={houseRules}
          globalRules={globalRules}
          onEdit={startEdit}
          onOverride={startOverride}
          onReset={resetToGlobal}
        />
      )}
    </section>
  );
}

function RuleList({
  houseRules,
  globalRules,
  onEdit,
  onOverride,
  onReset,
}: {
  houseRules: readonly HouseConversionRule[];
  globalRules: readonly GlobalConversionRule[];
  onEdit: (r: HouseConversionRule) => void;
  onOverride: (r: GlobalConversionRule) => void;
  onReset: (r: HouseConversionRule) => void;
}) {
  type Row =
    | { kind: 'house'; rule: HouseConversionRule; globalOverride?: GlobalConversionRule }
    | { kind: 'global'; rule: GlobalConversionRule };

  const houseByKey = new Map<string, HouseConversionRule>();
  for (const r of houseRules) {
    houseByKey.set(`${r.fromUnit}::${r.toUnit}::${r.ingredientName ?? ''}`, r);
  }

  const rows: Row[] = [];
  for (const r of houseRules) {
    const g = globalRules.find(
      (x) =>
        x.fromUnit === r.fromUnit &&
        x.toUnit === r.toUnit &&
        (x.ingredientName ?? '') === (r.ingredientName ?? ''),
    );
    rows.push({ kind: 'house', rule: r, globalOverride: g });
  }
  for (const g of globalRules) {
    const key = `${g.fromUnit}::${g.toUnit}::${g.ingredientName ?? ''}`;
    if (!houseByKey.has(key)) rows.push({ kind: 'global', rule: g });
  }
  // Group ingredient-specific rules under their ingredient, generic at top.
  rows.sort((a, b) => {
    const aName = a.kind === 'house' ? a.rule.ingredientName : a.rule.ingredientName;
    const bName = b.kind === 'house' ? b.rule.ingredientName : b.rule.ingredientName;
    if ((aName ?? '') < (bName ?? '')) return -1;
    if ((aName ?? '') > (bName ?? '')) return 1;
    // HOUSE before GLOBAL within the same ingredient group.
    if (a.kind !== b.kind) return a.kind === 'house' ? -1 : 1;
    return 0;
  });

  if (rows.length === 0) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">No rules yet.</p>;
  }

  return (
    <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-md border border-stone-200 dark:border-stone-700">
      {rows.map((row, i) => (
        <li
          key={i}
          className={`flex flex-wrap items-center gap-x-2 gap-y-1 p-3 text-sm ${
            row.kind === 'global' ? 'text-stone-500 dark:text-stone-400' : ''
          }`}
        >
          <RuleSentence
            fromUnit={row.rule.fromUnit}
            toUnit={row.rule.toUnit}
            factor={row.rule.factor}
            ingredient={row.rule.ingredientName}
          />
          {row.kind === 'house' &&
            row.globalOverride &&
            row.globalOverride.factor !== row.rule.factor && (
              <span className="rounded border border-stone-300 dark:border-stone-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
                Overrides global ({row.globalOverride.factor} → {row.rule.factor})
              </span>
            )}
          {row.kind === 'global' && (
            <span className="rounded border border-stone-300 dark:border-stone-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Global default
            </span>
          )}
          {ruleNotes(row.rule) && (
            <span
              className="basis-full text-xs italic text-stone-500 dark:text-stone-400"
              title={ruleNotes(row.rule) ?? undefined}
            >
              {ruleNotes(row.rule)}
            </span>
          )}
          <span className="ml-auto flex gap-1">
            {row.kind === 'house' ? (
              <>
                <button
                  type="button"
                  onClick={() => onEdit(row.rule)}
                  className="rounded-md px-2 py-1 text-xs text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
                >
                  Edit
                </button>
                {row.globalOverride && (
                  <button
                    type="button"
                    onClick={() => onReset(row.rule)}
                    className="rounded-md px-2 py-1 text-xs text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
                  >
                    Reset to global
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (confirm('Delete this rule?')) onReset(row.rule);
                  }}
                  className="rounded-md px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
                >
                  Delete
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => onOverride(row.rule)}
                className="rounded-md px-2 py-1 text-xs text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                Override
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RuleSentence({
  fromUnit,
  toUnit,
  factor,
  ingredient,
}: {
  fromUnit: string;
  toUnit: string;
  factor: number;
  ingredient: string | null;
}) {
  return (
    <span>
      1 <strong>{fromUnit}</strong>
      {ingredient ? <> {ingredient}</> : <span className="italic"> (any)</span>}
      <span className="text-stone-500 dark:text-stone-400"> ≈ </span>
      <strong>{formatFactor(factor)}</strong> {toUnit}
    </span>
  );
}

function ruleNotes(rule: HouseConversionRule | GlobalConversionRule): string | null {
  return rule.notes && rule.notes.trim() !== '' ? rule.notes : null;
}

function formatFactor(n: number): string {
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, '');
  if (n >= 1) return n.toFixed(2).replace(/\.?0+$/, '');
  return n.toPrecision(3);
}

function useDistinctIngredientNames(): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await getLocalDb();
        const rows = (await db.execO<{ name: string }>(
          `select distinct lower(name) as name
             from ingredients
            where name is not null and name != ''
            order by name asc
            limit 500`,
        )) as { name: string }[];
        if (!cancelled) setNames(rows.map((r) => r.name));
      } catch {
        /* local DB not ready yet */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return names;
}
