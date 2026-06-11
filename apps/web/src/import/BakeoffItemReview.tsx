import type { ParsedRecipeDraft } from '@cookyourbooks/domain';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { useSync } from '../local/SyncProvider.js';
import {
  getBatchVariants,
  getItemVariantResults,
  type ImportBatchVariantRow,
  type ImportItemVariantResultRow,
  promoteBakeoffVariant,
  selectBakeoffWinner,
} from './api.js';
import { computeDraftDiff } from './bakeoff.js';
import { DraftPreview } from './DraftPreview.js';

/**
 * Side-by-side variant comparison for a bakeoff import item in
 * BAKEOFF_READY status. User picks the winning OCR config; drafts copy
 * onto the item and review continues as normal.
 */
export function BakeoffItemReview({
  batchId,
  itemId,
  onWinnerSelected,
}: {
  batchId: string;
  itemId: string;
  onWinnerSelected: () => void;
}) {
  const { syncNow } = useSync();
  const [leftId, setLeftId] = useState<string | undefined>();
  const [rightId, setRightId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [promotedId, setPromotedId] = useState<string | undefined>();

  const { data: variants = [] } = useQuery({
    queryKey: ['import-batch-variants', batchId],
    queryFn: () => getBatchVariants(batchId),
    refetchInterval: 3_000,
  });

  const { data: results = [], refetch } = useQuery({
    queryKey: ['import-item-variant-results', itemId],
    queryFn: () => getItemVariantResults(itemId),
    refetchInterval: 2_000,
  });

  const okResults = useMemo(() => results.filter((r) => r.status === 'DONE'), [results]);

  const variantById = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants]);

  useEffect(() => {
    if (okResults.length >= 2) {
      if (!leftId || !okResults.find((r) => r.variant_id === leftId)) {
        setLeftId(okResults[0]!.variant_id);
      }
      if (!rightId || rightId === leftId || !okResults.find((r) => r.variant_id === rightId)) {
        const fallback = okResults.find(
          (r) => r.variant_id !== (leftId ?? okResults[0]!.variant_id),
        );
        setRightId(fallback?.variant_id);
      }
    }
  }, [okResults, leftId, rightId]);

  const pending = results.some((r) => r.status === 'PENDING' || r.status === 'CLAIMED');

  async function pickWinner(variantId: string) {
    setBusy(true);
    setError(undefined);
    try {
      await selectBakeoffWinner(itemId, variantId);
      await syncNow();
      onWinnerSelected();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function promote(variantId: string) {
    try {
      await promoteBakeoffVariant(variantId);
      setPromotedId(variantId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (pending) {
    return (
      <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        Running OCR variants… Results will appear here as each model finishes.
      </div>
    );
  }

  if (okResults.length === 0) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        All variants failed. Check Settings → OCR keys or re-OCR from the batch board.
      </div>
    );
  }

  const left = okResults.find((r) => r.variant_id === leftId);
  const right = okResults.find((r) => r.variant_id === rightId);
  const leftDraft = (left?.drafts?.[0] ?? undefined) as ParsedRecipeDraft | undefined;
  const rightDraft = (right?.drafts?.[0] ?? undefined) as ParsedRecipeDraft | undefined;
  const diff = leftDraft && rightDraft ? computeDraftDiff(leftDraft, rightDraft) : undefined;

  return (
    <div className="space-y-4" data-testid="bakeoff-item-review">
      <div className="rounded-md border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900">
        Pick the best OCR result for this page. You can edit the recipe after choosing a winner.
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      <VariantResultsTable
        variants={variants}
        results={results}
        promotedId={promotedId}
        busy={busy}
        onPick={(vid) => void pickWinner(vid)}
        onPromote={(vid) => void promote(vid)}
      />

      {okResults.length >= 2 &&
        left &&
        right &&
        leftDraft &&
        rightDraft &&
        diff &&
        leftId &&
        rightId && (
          <section className="space-y-3" data-testid="bakeoff-diff">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Compare</h3>
              <select
                value={leftId}
                aria-label="Diff left variant"
                onChange={(e) => setLeftId(e.target.value)}
                className="rounded border border-stone-300 px-2 py-1 text-xs"
              >
                {okResults.map((r) => (
                  <option key={r.variant_id} value={r.variant_id}>
                    {variantById.get(r.variant_id)?.name ?? r.variant_id}
                  </option>
                ))}
              </select>
              <span className="text-xs">vs</span>
              <select
                value={rightId}
                aria-label="Diff right variant"
                onChange={(e) => setRightId(e.target.value)}
                className="rounded border border-stone-300 px-2 py-1 text-xs"
              >
                {okResults.map((r) => (
                  <option key={r.variant_id} value={r.variant_id}>
                    {variantById.get(r.variant_id)?.name ?? r.variant_id}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <DraftPreview draft={leftDraft} highlights={diff.left} side="left" />
              <DraftPreview draft={rightDraft} highlights={diff.right} side="right" />
            </div>
          </section>
        )}

      <button
        type="button"
        onClick={() => void refetch()}
        className="text-xs text-stone-500 underline"
      >
        Refresh results
      </button>
    </div>
  );
}

function VariantResultsTable({
  variants,
  results,
  promotedId,
  busy,
  onPick,
  onPromote,
}: {
  variants: ImportBatchVariantRow[];
  results: ImportItemVariantResultRow[];
  promotedId: string | undefined;
  busy: boolean;
  onPick: (variantId: string) => void;
  onPromote: (variantId: string) => void;
}) {
  const byVariant = new Map(results.map((r) => [r.variant_id, r]));
  return (
    <table className="min-w-full text-sm" data-testid="bakeoff-results">
      <thead>
        <tr className="text-left text-xs uppercase text-stone-500">
          <th className="py-2 pr-4">Variant</th>
          <th className="py-2 pr-4">Status</th>
          <th className="py-2 pr-4">Latency</th>
          <th className="py-2 pr-4">Cost</th>
          <th className="py-2 pr-4">Action</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-100">
        {variants.map((v) => {
          const r = byVariant.get(v.id);
          return (
            <tr key={v.id} data-testid="bakeoff-result-row" data-variant-id={v.id}>
              <td className="py-2 pr-4">
                <div className="font-medium">{v.name || '(unnamed)'}</div>
                <div className="text-xs text-stone-500">
                  {v.provider} · <code>{v.model}</code>
                </div>
              </td>
              <td className="py-2 pr-4">
                {r?.status === 'DONE' ? (
                  <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                    OK
                  </span>
                ) : r?.status === 'FAILED' ? (
                  <span className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700">
                    {r.error_kind ?? 'Error'}
                  </span>
                ) : (
                  <span className="text-stone-500 text-xs">Processing…</span>
                )}
              </td>
              <td className="py-2 pr-4">
                {r?.latency_ms != null ? `${(r.latency_ms / 1000).toFixed(2)} s` : '—'}
              </td>
              <td className="py-2 pr-4">
                {r?.cost_usd_micros != null && r.cost_usd_micros > 0
                  ? `$${(r.cost_usd_micros / 1_000_000).toFixed(4)}`
                  : '—'}
              </td>
              <td className="py-2 pr-4 space-x-2">
                {r?.status === 'DONE' && (
                  <button
                    type="button"
                    disabled={busy}
                    data-testid="bakeoff-pick-winner"
                    data-variant-id={v.id}
                    onClick={() => onPick(v.id)}
                    className="rounded-md bg-stone-900 px-2 py-1 text-xs text-white hover:bg-stone-800 disabled:opacity-60"
                  >
                    Use this one
                  </button>
                )}
                {r?.status === 'DONE' && (
                  <button
                    type="button"
                    data-testid="bakeoff-promote"
                    data-variant-id={v.id}
                    disabled={promotedId === v.id}
                    onClick={() => onPromote(v.id)}
                    className="rounded-md border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100 disabled:opacity-60"
                  >
                    {promotedId === v.id ? 'Default ✓' : 'Set as default'}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
