import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  diffLines,
  runBakeoff,
  summarizeDraftForDiff,
  type BakeoffResult,
  type BakeoffVariant,
} from '../import/bakeoff.js';
import {
  DEFAULT_VARIANTS,
  loadBakeoffVariants,
  newVariant,
  saveBakeoffVariants,
} from '../settings/bakeoffSettings.js';
import {
  DEFAULT_MODEL_BY_PROVIDER,
  loadOcrSettings,
  type OcrProvider,
} from '../settings/ocrSettings.js';

/**
 * Side-by-side OCR shootout. The user uploads a single image, configures
 * a matrix of (provider × model × prompt) variants, kicks them off in
 * parallel, and inspects per-variant cost / wall time / parsed output.
 * A diff view between any two variants helps spot where models disagree.
 *
 * This page deliberately stays client-side: it reuses the same API key as
 * the legacy in-browser Import-from-Photo path (`loadOcrSettings`). The
 * bulk Edge-Function-driven import flow is for production runs; this
 * page is an experimentation tool.
 */
export function BakeoffPage() {
  const [variants, setVariants] = useState<BakeoffVariant[]>(() => loadBakeoffVariants());
  const [file, setFile] = useState<File | undefined>();
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [results, setResults] = useState<Map<string, BakeoffResult>>(new Map());
  const [running, setRunning] = useState(false);
  const [topLevelError, setTopLevelError] = useState<string | undefined>();
  const [leftId, setLeftId] = useState<string | undefined>();
  const [rightId, setRightId] = useState<string | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persist the variant matrix on every change so the user doesn't lose
  // their carefully-tuned set when they navigate away mid-experiment.
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

  function patchVariant(id: string, patch: Partial<BakeoffVariant>) {
    setVariants((cur) =>
      cur.map((v) => {
        if (v.id !== id) return v;
        const next = { ...v, ...patch };
        // Switching providers — adopt the new provider's default model
        // unless the user has clearly typed something custom.
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
    setResults((cur) => {
      const next = new Map(cur);
      next.delete(id);
      return next;
    });
    if (leftId === id) setLeftId(undefined);
    if (rightId === id) setRightId(undefined);
  }

  function resetToDefaults() {
    if (!confirm('Reset the variant list to defaults?')) return;
    setVariants(DEFAULT_VARIANTS.map((v) => ({ ...v })));
    setResults(new Map());
  }

  async function runAll() {
    if (!file) {
      setTopLevelError('Upload an image first.');
      return;
    }
    if (variants.length === 0) {
      setTopLevelError('Add at least one variant.');
      return;
    }
    // Shim-mode skips the API key check so E2E tests don't need a real key.
    const shimActive = typeof window !== 'undefined' && !!window.__cybBakeoffShim;
    const settings = loadOcrSettings();
    if (!shimActive && (!settings || !settings.apiKey)) {
      setTopLevelError(
        'No OCR API key is configured. Set one in Settings before running the bakeoff.',
      );
      return;
    }
    setTopLevelError(undefined);
    setResults(new Map());
    setRunning(true);
    try {
      await runBakeoff(variants, file, settings?.apiKey ?? '', (r) => {
        setResults((cur) => {
          const next = new Map(cur);
          next.set(r.variantId, r);
          return next;
        });
      });
    } finally {
      setRunning(false);
    }
  }

  const okResults = useMemo(
    () =>
      variants
        .map((v) => results.get(v.id))
        .filter((r): r is BakeoffResult & { status: 'ok' } => r?.status === 'ok'),
    [variants, results],
  );

  // Default the diff selectors to the first two successful variants once
  // we have them — saves a click for the common "compare the only two
  // models I ran" case.
  useEffect(() => {
    if (okResults.length >= 2) {
      if (!leftId || !okResults.find((r) => r.variantId === leftId)) {
        setLeftId(okResults[0]!.variantId);
      }
      if (
        !rightId ||
        rightId === leftId ||
        !okResults.find((r) => r.variantId === rightId)
      ) {
        const fallback = okResults.find((r) => r.variantId !== (leftId ?? okResults[0]!.variantId));
        setRightId(fallback?.variantId);
      }
    }
  }, [okResults, leftId, rightId]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">OCR bakeoff</h1>
          <p className="mt-1 text-sm text-stone-600">
            Race multiple prompts and models against the same photo. Compare cost, latency,
            and parsed output side by side.
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
          ref={fileInputRef}
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
          disabled={running || !file}
          data-testid="bakeoff-run"
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
        >
          {running ? 'Running…' : `Run bakeoff (${variants.length})`}
        </button>
      </div>

      {(results.size > 0 || running) && (
        <ResultsTable variants={variants} results={results} running={running} />
      )}

      {okResults.length >= 2 && leftId && rightId && (
        <DiffSection
          variants={variants}
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
  variant: BakeoffVariant;
  index: number;
  canDelete: boolean;
  onChange: (patch: Partial<BakeoffVariant>) => void;
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
  results,
  running,
}: {
  variants: readonly BakeoffVariant[];
  results: Map<string, BakeoffResult>;
  running: boolean;
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
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {variants.map((v) => {
              const r = results.get(v.id);
              return (
                <tr key={v.id} data-testid="bakeoff-result-row" data-variant-id={v.id}>
                  <td className="py-2 pr-4 align-top">
                    <div className="font-medium">{v.name}</div>
                    <div className="text-xs text-stone-500">
                      {v.provider} · <code>{v.model}</code>
                    </div>
                  </td>
                  <td className="py-2 pr-4 align-top">
                    {!r ? (
                      <span className="text-stone-500">{running ? 'running…' : 'pending'}</span>
                    ) : r.status === 'ok' ? (
                      <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                        OK
                      </span>
                    ) : (
                      <span
                        title={r.error}
                        className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700"
                      >
                        Error
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 align-top">
                    {r ? `${(r.elapsedMs / 1000).toFixed(2)} s` : '—'}
                  </td>
                  <td className="py-2 pr-4 align-top">
                    {r?.status === 'ok'
                      ? `${r.usage.promptTokens.toLocaleString()} / ${r.usage.completionTokens.toLocaleString()}`
                      : '—'}
                  </td>
                  <td className="py-2 pr-4 align-top">
                    {r?.status === 'ok' ? formatCost(r.costUsdMicros) : '—'}
                  </td>
                  <td className="py-2 pr-4 align-top">
                    {r?.status === 'ok' ? (
                      <DraftSummary result={r} />
                    ) : r?.status === 'error' ? (
                      <span className="text-xs text-red-700">{r.error}</span>
                    ) : (
                      <span className="text-xs text-stone-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DraftSummary({
  result,
}: {
  result: BakeoffResult & { status: 'ok' };
}) {
  const total = result.drafts.length;
  const first = result.drafts[0];
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
  variants,
  results,
  leftId,
  rightId,
  onLeft,
  onRight,
}: {
  variants: readonly BakeoffVariant[];
  results: ReadonlyArray<BakeoffResult & { status: 'ok' }>;
  leftId: string;
  rightId: string;
  onLeft: (id: string) => void;
  onRight: (id: string) => void;
}) {
  const left = results.find((r) => r.variantId === leftId);
  const right = results.find((r) => r.variantId === rightId);
  const nameOf = (id: string) => variants.find((v) => v.id === id)?.name ?? id;

  const diff = useMemo(() => {
    if (!left || !right) return [];
    // Diff the *first* draft from each side. The vast majority of photos
    // produce a single recipe; for multi-recipe spreads the user can swap
    // selectors to compare a different pairing.
    const leftSummary = left.drafts[0] ? summarizeDraftForDiff(left.drafts[0]) : '';
    const rightSummary = right.drafts[0] ? summarizeDraftForDiff(right.drafts[0]) : '';
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
                <option key={r.variantId} value={r.variantId}>
                  {nameOf(r.variantId)}
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
                <option key={r.variantId} value={r.variantId}>
                  {nameOf(r.variantId)}
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
