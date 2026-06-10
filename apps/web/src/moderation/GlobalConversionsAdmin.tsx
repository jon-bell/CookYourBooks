import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Units, canonicalUnitName } from '@cookyourbooks/domain';
import { LoadingState } from '../components/LoadingState.js';
import {
  deleteGlobalConversion,
  upsertGlobalConversion,
  useGlobalConversionRules,
  type GlobalConversionRule,
} from '../data/conversions.js';

const UNIT_OPTIONS = Object.values(Units)
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
  fromUnit: 'milliliter',
  ingredient: '',
  toAmount: '',
  toUnit: 'gram',
  notes: '',
};

/**
 * Admin-only editor for the shared `global_conversions` table.
 * Mirrors the ConversionsSection sentence builder; differences are
 * (a) writes go through the admin RPC and (b) a notes column is
 * surfaced for explanatory context (e.g. "honey @ 20°C").
 */
export function GlobalConversionsAdmin() {
  const { data: rules = [], isLoading } = useGlobalConversionRules();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function startEdit(rule: GlobalConversionRule) {
    setDraft({
      id: rule.id,
      fromAmount: '1',
      fromUnit: rule.fromUnit,
      ingredient: rule.ingredientName ?? '',
      toAmount: String(rule.factor),
      toUnit: rule.toUnit,
      notes: rule.notes ?? '',
    });
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
    if (!Number.isFinite(fromAmount) || fromAmount <= 0 || !Number.isFinite(toAmount) || toAmount <= 0) {
      setError('Both amounts must be positive numbers.');
      return;
    }
    const fromUnit = canonicalUnitName(draft.fromUnit);
    const toUnit = canonicalUnitName(draft.toUnit);
    if (!fromUnit || !toUnit) {
      setError('Pick units for both sides.');
      return;
    }
    setBusy(true);
    try {
      await upsertGlobalConversion({
        id: draft.id,
        fromUnit,
        toUnit,
        factor: toAmount / fromAmount,
        ingredientName: draft.ingredient.trim().toLowerCase() || null,
        notes: draft.notes.trim() || null,
      });
      // Realtime invalidates the cache, but on the same tab we want
      // the row visible *now*.
      await qc.invalidateQueries({ queryKey: ['conversion-rules', 'global'] });
      setDraft(EMPTY_DRAFT);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: GlobalConversionRule) {
    if (!confirm(`Delete the global rule for ${rule.ingredientName ?? '(generic)'}?`)) return;
    try {
      await deleteGlobalConversion(rule.id);
      await qc.invalidateQueries({ queryKey: ['conversion-rules', 'global'] });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="space-y-4">
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Edits here propagate to every user. Densities and piece-to-gram defaults live
        here so we can fix a wrong number without a deploy.
      </p>

      <form
        className="space-y-2 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input
            type="number"
            min={0}
            step="any"
            value={draft.fromAmount}
            onChange={(e) => setDraft((d) => ({ ...d, fromAmount: e.target.value }))}
            className="w-20 rounded border border-stone-300 dark:border-stone-600 px-2 py-1"
            aria-label="Left-hand amount"
          />
          <select
            value={draft.fromUnit}
            onChange={(e) => setDraft((d) => ({ ...d, fromUnit: e.target.value }))}
            className="rounded border border-stone-300 dark:border-stone-600 px-2 py-1"
            aria-label="From unit"
          >
            {UNIT_OPTIONS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <input
            type="text"
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
        </div>
        <input
          type="text"
          value={draft.notes}
          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
          placeholder="Notes (optional, shown to admins only)"
          className="w-full rounded border border-stone-300 dark:border-stone-600 px-2 py-1 text-sm"
        />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
          >
            {draft.id ? 'Update' : 'Add global rule'}
          </button>
          {draft.id && (
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-md px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              Cancel
            </button>
          )}
          {error && <span className="text-red-700 dark:text-red-300">{error}</span>}
        </div>
      </form>

      {isLoading && rules.length === 0 ? (
        <LoadingState surface="admin-conversions" size="inline" />
      ) : (
        <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
          {[...rules]
            .sort((a, b) =>
              (a.ingredientName ?? '').localeCompare(b.ingredientName ?? '') ||
              a.fromUnit.localeCompare(b.fromUnit),
            )
            .map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                <span>
                  1 <strong>{r.fromUnit}</strong>
                  {r.ingredientName ? <> {r.ingredientName}</> : <span className="italic"> (any)</span>}
                  <span className="text-stone-500 dark:text-stone-400"> ≈ </span>
                  <strong>{r.factor}</strong> {r.toUnit}
                </span>
                {r.notes && (
                  <span className="text-xs text-stone-500 dark:text-stone-400">— {r.notes}</span>
                )}
                <span className="ml-auto flex gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(r)}
                    className="rounded-md px-2 py-1 text-xs text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(r)}
                    className="rounded-md px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
