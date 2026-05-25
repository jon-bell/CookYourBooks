import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  diffLines,
  summarizeDraftForDiff,
} from '../import/bakeoff.js';
import {
  DEFAULT_VARIANTS,
  loadBakeoffVariants,
  newVariant,
  saveBakeoffVariants,
  type LocalBakeoffVariant,
} from '../settings/bakeoffSettings.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../settings/ocrSettings.js';
import {
  getBakeoffRun,
  kickOcr,
  promoteBakeoffVariant,
  startBakeoff,
  type BakeoffVariantRow,
  type OcrProvider,
} from '../import/api.js';
import { uploadBakeoffImage } from '../import/uploadBatch.js';
import { useAuth } from '../auth/AuthProvider.js';
import type { ParsedRecipeDraft } from '@cookyourbooks/domain';

/**
 * Side-by-side OCR shootout. The user uploads a single image, configures
 * a matrix of (provider × model × prompt) variants, kicks them off via
 * the same Edge Function the bulk-import flow uses, and inspects
 * per-variant cost / wall time / parsed output as the worker streams
 * results back. A diff view between any two variants helps spot where
 * models disagree, and "Set as default" promotes a variant's config
 * into the user's import defaults.
 */
export function BakeoffPage() {
  const { user } = useAuth();
  const [variants, setVariants] = useState<LocalBakeoffVariant[]>(() =>
    loadBakeoffVariants(),
  );
  const [file, setFile] = useState<File | undefined>();
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [runId, setRunId] = useState<string | undefined>();
  const [serverVariants, setServerVariants] = useState<BakeoffVariantRow[]>([]);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'starting' | 'running' | 'done'>(
    'idle',
  );
  const [topLevelError, setTopLevelError] = useState<string | undefined>();
  const [promotedId, setPromotedId] = useState<string | undefined>();
  const [leftId, setLeftId] = useState<string | undefined>();
  const [rightId, setRightId] = useState<string | undefined>();
  const pollTimer = useRef<number | null>(null);

  // Persist the variant *template* on every change so the form survives
  // navigation. The run itself is server-owned.
  useEffect(() => {
    saveBakeoffVariants(variants);
  }, [variants]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Stream results in. Realtime would be ideal but local-dev realtime is
  // sometimes flaky; a 1.5s poll alongside the realtime subscription is
  // cheap and reliable. We tear it down when every variant has settled.
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    async function tick() {
      try {
        const { variants: rows } = await getBakeoffRun(runId!);
        if (cancelled) return;
        setServerVariants(rows);
        const settled = rows.every((v) => v.status === 'DONE' || v.status === 'FAILED');
        if (settled) {
          setPhase('done');
          if (pollTimer.current) {
            window.clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
        }
      } catch (e) {
        if (!cancelled) setTopLevelError((e as Error).message);
      }
    }
    void tick();
    pollTimer.current = window.setInterval(() => void tick(), 1_500);
    return () => {
      cancelled = true;
      if (pollTimer.current) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [runId]);

  function patchVariant(id: string, patch: Partial<LocalBakeoffVariant>) {
    setVariants((cur) =>
      cur.map((v) => {
        if (v.id !== id) return v;
        const next = { ...v, ...patch };
        if (patch.provider && patch.provider !== v.provider) {
          if (v.model === DEFAULT_MODEL_BY_PROVIDER[v.provider]) {
            next.model = DEFAULT_MODEL_BY_PROVIDER[patch.provider];
          }
        }
        return next;
      }),
    );
  }

  function addVariant() {
    setVariants((cur) => [...cur, newVariant()]);
  }

  function removeVariant(id: string) {
    setVariants((cur) => (cur.length <= 1 ? cur : cur.filter((v) => v.id !== id)));
  }

  function resetToDefaults() {
    if (!confirm('Reset the variant list to defaults?')) return;
    setVariants(DEFAULT_VARIANTS.map((v) => ({ ...v })));
  }

  async function runAll() {
    if (!file) {
      setTopLevelError('Upload an image first.');
      return;
    }
    if (!user) {
      setTopLevelError('Not signed in.');
      return;
    }
    if (variants.length === 0) {
      setTopLevelError('Add at least one variant.');
      return;
    }
    setTopLevelError(undefined);
    setRunId(undefined);
    setServerVariants([]);
    setPromotedId(undefined);
    try {
      setPhase('uploading');
      const storagePath = await uploadBakeoffImage(user.id, file);
      setPhase('starting');
      const id = await startBakeoff(
        storagePath,
        variants.map((v) => ({
          name: v.name,
          provider: v.provider,
          model: v.model,
          prompt: v.prompt,
          base_url: v.baseUrl,
        })),
      );
      // Kick the worker so we don't wait for the next 30s cron tick.
      // `ocr_kick(null)` is fine — the bakeoff loop scans all PENDING
      // variants regardless of batch.
      try {
        await kickOcr();
      } catch (e) {
        // Worker not configured is a common local-dev case. Surface it
        // but don't block the page — the cron tick will eventually pick
        // it up if the secret is set later.
        setTopLevelError(
          `Worker kick failed (${(e as Error).message}). Variants are queued; results will appear when the worker runs.`,
        );
      }
      setRunId(id);
      setPhase('running');
    } catch (e) {
      setTopLevelError((e as Error).message);
      setPhase('idle');
    }
  }

  async function promote(variantId: string) {
    try {
      await promoteBakeoffVariant(variantId);
      setPromotedId(variantId);
    } catch (e) {
      setTopLevelError((e as Error).message);
    }
  }

  const okResults = useMemo(
    () => serverVariants.filter((v) => v.status === 'DONE'),
    [serverVariants],
  );

  useEffect(() => {
    if (okResults.length >= 2) {
      if (!leftId || !okResults.find((r) => r.id === leftId)) {
        setLeftId(okResults[0]!.id);
      }
      if (!rightId || rightId === leftId || !okResults.find((r) => r.id === rightId)) {
        const fallback = okResults.find((r) => r.id !== (leftId ?? okResults[0]!.id));
        setRightId(fallback?.id);
      }
    }
  }, [okResults, leftId, rightId]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">OCR bakeoff</h1>
          <p className="mt-1 text-sm text-stone-600">
            Race multiple prompts and models against the same photo. Uses your existing
            server-side OCR keys (Settings → OCR keys). Promote a winner to make it the
            default for new imports.
          </p>
        </div>
        <Link to="/import" className="text-sm underline text-stone-700">
          ← Back to imports
        </Link>
      </header>

      {topLevelError && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {topLevelError}
        </div>
      )}

      <section className="rounded-lg border border-stone-200 bg-white p-5 space-y-3">
        <h2 className="text-lg font-semibold">1. Pick a photo</h2>
        <input
          type="file"
          accept="image/*"
          data-testid="bakeoff-file-input"
          onChange={(e) => setFile(e.target.files?.[0] ?? undefined)}
          className="block text-sm"
        />
        {previewUrl && (
          <img
            src={previewUrl}
            alt="Selected"
            className="max-h-40 rounded border border-stone-200"
          />
        )}
      </section>

      <section className="rounded-lg border border-stone-200 bg-white p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">2. Variants</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={addVariant}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
            >
              + Add variant
            </button>
            <button
              type="button"
              onClick={resetToDefaults}
              className="rounded-md px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100"
            >
              Reset
            </button>
          </div>
        </div>
        <ul className="space-y-3" data-testid="bakeoff-variants">
          {variants.map((v, i) => (
            <VariantRow
              key={v.id}
              variant={v}
              index={i}
              canDelete={variants.length > 1}
              onChange={(patch) => patchVariant(v.id, patch)}
              onDelete={() => removeVariant(v.id)}
            />
          ))}
        </ul>
      </section>

      <div>
        <button
          type="button"
          onClick={() => void runAll()}
          disabled={!file || phase === 'uploading' || phase === 'starting'}
          data-testid="bakeoff-run"
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
        >
          {phase === 'uploading'
            ? 'Uploading…'
            : phase === 'starting'
              ? 'Starting…'
              : phase === 'running'
                ? 'Running…'
                : `Run bakeoff (${variants.length})`}
        </button>
      </div>

      {(serverVariants.length > 0 || phase === 'running') && (
        <ResultsTable
          variants={serverVariants}
          running={phase === 'running'}
          promotedId={promotedId}
          onPromote={(id) => void promote(id)}
        />
      )}

      {okResults.length >= 2 && leftId && rightId && (
        <DiffSection
          results={okResults}
          leftId={leftId}
          rightId={rightId}
          onLeft={setLeftId}
          onRight={setRightId}
        />
      )}
    </div>
  );
}

function VariantRow({
  variant,
  index,
  canDelete,
  onChange,
  onDelete,
}: {
  variant: LocalBakeoffVariant;
  index: number;
  canDelete: boolean;
  onChange: (patch: Partial<LocalBakeoffVariant>) => void;
  onDelete: () => void;
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <li
      data-testid="bakeoff-variant"
      data-variant-id={variant.id}
      className="rounded-md border border-stone-200 p-3 space-y-2"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <label className="text-xs text-stone-600">
          Variant {index + 1} name
          <input
            type="text"
            value={variant.name}
            aria-label={`Variant ${index + 1} name`}
            onChange={(e) => onChange({ name: e.target.value })}
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-stone-600">
          Provider
          <select
            value={variant.provider}
            aria-label={`Variant ${index + 1} provider`}
            onChange={(e) => onChange({ provider: e.target.value as OcrProvider })}
            className="mt-1 block rounded border border-stone-300 px-2 py-1 text-sm"
          >
            <option value="gemini">Gemini</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>
        <button
          type="button"
          onClick={onDelete}
          disabled={!canDelete}
          className="rounded-md px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-30"
        >
          Remove
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs text-stone-600">
          Model
          <input
            type="text"
            value={variant.model}
            aria-label={`Variant ${index + 1} model`}
            onChange={(e) => onChange({ model: e.target.value })}
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1 font-mono text-xs"
          />
        </label>
        {variant.provider === 'openai-compatible' && (
          <label className="text-xs text-stone-600">
            Base URL
            <input
              type="text"
              value={variant.baseUrl ?? ''}
              aria-label={`Variant ${index + 1} base URL`}
              onChange={(e) => onChange({ baseUrl: e.target.value || undefined })}
              placeholder="https://api.openai.com/v1"
              className="mt-1 w-full rounded border border-stone-300 px-2 py-1 font-mono text-xs"
            />
          </label>
        )}
      </div>
      <details
        open={showPrompt}
        onToggle={(e) => setShowPrompt((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-xs text-stone-600">
          Prompt ({variant.prompt.length.toLocaleString()} chars)
        </summary>
        <textarea
          value={variant.prompt}
          aria-label={`Variant ${index + 1} prompt`}
          onChange={(e) => onChange({ prompt: e.target.value })}
          rows={8}
          className="mt-1 w-full rounded border border-stone-300 p-2 font-mono text-xs"
        />
      </details>
    </li>
  );
}

function ResultsTable({
  variants,
  running,
  promotedId,
  onPromote,
}: {
  variants: readonly BakeoffVariantRow[];
  running: boolean;
  promotedId: string | undefined;
  onPromote: (id: string) => void;
}) {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-5 space-y-3">
      <h2 className="text-lg font-semibold">Results</h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm" data-testid="bakeoff-results">
          <thead>
            <tr className="text-left text-xs uppercase text-stone-500">
              <th className="py-2 pr-4">Variant</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Latency</th>
              <th className="py-2 pr-4">Tokens (in / out)</th>
              <th className="py-2 pr-4">Cost</th>
              <th className="py-2 pr-4">Output</th>
              <th className="py-2 pr-4">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {variants.map((v) => (
              <tr key={v.id} data-testid="bakeoff-result-row" data-variant-id={v.id}>
                <td className="py-2 pr-4 align-top">
                  <div className="font-medium">{v.name || '(unnamed)'}</div>
                  <div className="text-xs text-stone-500">
                    {v.provider} · <code>{v.model}</code>
                  </div>
                </td>
                <td className="py-2 pr-4 align-top">
                  {v.status === 'DONE' ? (
                    <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                      OK
                    </span>
                  ) : v.status === 'FAILED' ? (
                    <span
                      title={v.error_message ?? undefined}
                      className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700"
                    >
                      {v.error_kind ?? 'Error'}
                    </span>
                  ) : (
                    <span className="text-stone-500">
                      {running ? v.status.toLowerCase() + '…' : v.status.toLowerCase()}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 align-top">
                  {v.latency_ms != null ? `${(v.latency_ms / 1000).toFixed(2)} s` : '—'}
                </td>
                <td className="py-2 pr-4 align-top">
                  {v.status === 'DONE'
                    ? `${(v.prompt_tokens ?? 0).toLocaleString()} / ${(v.completion_tokens ?? 0).toLocaleString()}`
                    : '—'}
                </td>
                <td className="py-2 pr-4 align-top">
                  {v.status === 'DONE' ? formatCost(v.cost_usd_micros ?? 0) : '—'}
                </td>
                <td className="py-2 pr-4 align-top">
                  {v.status === 'DONE' ? (
                    <DraftSummary drafts={(v.drafts ?? []) as ParsedRecipeDraft[]} />
                  ) : v.status === 'FAILED' ? (
                    <span className="text-xs text-red-700">{v.error_message}</span>
                  ) : (
                    <span className="text-xs text-stone-400">—</span>
                  )}
                </td>
                <td className="py-2 pr-4 align-top">
                  {v.status === 'DONE' && (
                    <button
                      type="button"
                      onClick={() => onPromote(v.id)}
                      disabled={promotedId === v.id}
                      data-testid="bakeoff-promote"
                      data-variant-id={v.id}
                      className="rounded-md border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100 disabled:opacity-60"
                    >
                      {promotedId === v.id ? 'Default ✓' : 'Set as default'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DraftSummary({ drafts }: { drafts: ParsedRecipeDraft[] }) {
  const total = drafts.length;
  const first = drafts[0];
  return (
    <div className="space-y-0.5 text-xs">
      <div>
        {total} {total === 1 ? 'recipe' : 'recipes'}
      </div>
      {first && (
        <div className="text-stone-600">
          <span className="font-medium">{first.title ?? '(untitled)'}</span> ·{' '}
          {first.ingredients.length} ing · {first.instructions.length} step
        </div>
      )}
    </div>
  );
}

function DiffSection({
  results,
  leftId,
  rightId,
  onLeft,
  onRight,
}: {
  results: ReadonlyArray<BakeoffVariantRow>;
  leftId: string;
  rightId: string;
  onLeft: (id: string) => void;
  onRight: (id: string) => void;
}) {
  const left = results.find((r) => r.id === leftId);
  const right = results.find((r) => r.id === rightId);

  const diff = useMemo(() => {
    if (!left || !right) return [];
    const leftDrafts = (left.drafts ?? []) as ParsedRecipeDraft[];
    const rightDrafts = (right.drafts ?? []) as ParsedRecipeDraft[];
    const leftSummary = leftDrafts[0] ? summarizeDraftForDiff(leftDrafts[0]) : '';
    const rightSummary = rightDrafts[0] ? summarizeDraftForDiff(rightDrafts[0]) : '';
    return diffLines(leftSummary, rightSummary);
  }, [left, right]);

  return (
    <section
      className="rounded-lg border border-stone-200 bg-white p-5 space-y-3"
      data-testid="bakeoff-diff"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Diff</h2>
        <div className="flex items-center gap-2 text-xs">
          <label>
            <span className="sr-only">Left variant</span>
            <select
              value={leftId}
              aria-label="Diff left variant"
              onChange={(e) => onLeft(e.target.value)}
              className="rounded border border-stone-300 px-2 py-1 text-xs"
            >
              {results.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name || `(unnamed) ${r.model}`}
                </option>
              ))}
            </select>
          </label>
          <span>vs</span>
          <label>
            <span className="sr-only">Right variant</span>
            <select
              value={rightId}
              aria-label="Diff right variant"
              onChange={(e) => onRight(e.target.value)}
              className="rounded border border-stone-300 px-2 py-1 text-xs"
            >
              {results.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name || `(unnamed) ${r.model}`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <pre className="overflow-x-auto rounded border border-stone-200 bg-stone-50 p-3 text-xs leading-5">
        {diff.map((line, i) => (
          <div
            key={i}
            data-diff-kind={line.kind}
            className={
              line.kind === 'add'
                ? 'bg-emerald-50 text-emerald-900'
                : line.kind === 'del'
                  ? 'bg-red-50 text-red-900'
                  : 'text-stone-700'
            }
          >
            <span className="select-none pr-2 text-stone-400">
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
            </span>
            {line.text || ' '}
          </div>
        ))}
      </pre>
    </section>
  );
}

function formatCost(costUsdMicros: number): string {
  if (costUsdMicros <= 0) return '—';
  const usd = costUsdMicros / 1_000_000;
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(4)}`;
}
