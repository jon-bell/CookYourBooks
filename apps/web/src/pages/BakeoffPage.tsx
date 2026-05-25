import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  diffLines,
  summarizeDraftForDiff,
  summarizeRewriteForDiff,
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
  DEFAULT_REWRITE_MODEL_BY_PROVIDER,
  DEFAULT_REWRITE_PROMPT,
} from '../settings/rewriteSettings.js';
import {
  getBakeoffRun,
  kickOcr,
  kickRewrite,
  promoteBakeoffVariant,
  startBakeoff,
  type BakeoffVariantRow,
  type OcrProvider,
} from '../import/api.js';
import { useCollectionPickerOptions } from '../data/queries.js';
import { collectionRepo } from '../data/repos.js';
import { useAuth } from '../auth/AuthProvider.js';
import { uploadBakeoffImage } from '../import/uploadBatch.js';
import type { ParsedRecipeDraft } from '@cookyourbooks/domain';

type TaskKind = 'OCR' | 'REWRITE';

function defaultRewriteVariants(): LocalBakeoffVariant[] {
  return [
    {
      id: 'seed-rewrite-flash',
      name: 'Gemini Flash',
      provider: 'gemini',
      model: DEFAULT_REWRITE_MODEL_BY_PROVIDER.gemini,
      prompt: DEFAULT_REWRITE_PROMPT,
    },
    {
      id: 'seed-rewrite-pro',
      name: 'Gemini Pro',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      prompt: DEFAULT_REWRITE_PROMPT,
    },
  ];
}

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
  const [searchParams, setSearchParams] = useSearchParams();
  const taskKind: TaskKind = searchParams.get('task') === 'rewrite' ? 'REWRITE' : 'OCR';
  // OCR variants persist to localStorage; rewrite variants reseed each
  // visit from rewriteSettings defaults because the prompt is heavier
  // and users tune it via the Settings page rather than the bakeoff form.
  const [ocrVariants, setOcrVariants] = useState<LocalBakeoffVariant[]>(() =>
    loadBakeoffVariants(),
  );
  const [rewriteVariants, setRewriteVariants] = useState<LocalBakeoffVariant[]>(() =>
    defaultRewriteVariants(),
  );
  const variants = taskKind === 'REWRITE' ? rewriteVariants : ocrVariants;
  const setVariants: (
    next: LocalBakeoffVariant[] | ((cur: LocalBakeoffVariant[]) => LocalBakeoffVariant[]),
  ) => void = taskKind === 'REWRITE' ? setRewriteVariants : setOcrVariants;
  const [file, setFile] = useState<File | undefined>();
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [recipePick, setRecipePick] = useState<{ collectionId: string; recipeId: string } | null>(
    null,
  );
  const [runId, setRunId] = useState<string | undefined>();
  const [runTaskKind, setRunTaskKind] = useState<TaskKind>('OCR');
  const [serverVariants, setServerVariants] = useState<BakeoffVariantRow[]>([]);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'starting' | 'running' | 'done'>(
    'idle',
  );
  const [topLevelError, setTopLevelError] = useState<string | undefined>();
  const [promotedId, setPromotedId] = useState<string | undefined>();
  const [leftId, setLeftId] = useState<string | undefined>();
  const [rightId, setRightId] = useState<string | undefined>();
  const pollTimer = useRef<number | null>(null);

  function switchTask(next: TaskKind) {
    const params = new URLSearchParams(searchParams);
    if (next === 'OCR') params.delete('task');
    else params.set('task', 'rewrite');
    setSearchParams(params, { replace: true });
    // Don't carry over half-configured run state across tabs.
    setRunId(undefined);
    setServerVariants([]);
    setPhase('idle');
    setPromotedId(undefined);
  }

  // Persist the OCR variant *template* on every change so the form
  // survives navigation. The run itself is server-owned. Rewrite
  // variants are ephemeral — users tune the prompt in Settings.
  useEffect(() => {
    saveBakeoffVariants(ocrVariants);
  }, [ocrVariants]);

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
    if (taskKind === 'REWRITE') {
      setVariants(defaultRewriteVariants());
    } else {
      setVariants(DEFAULT_VARIANTS.map((v) => ({ ...v })));
    }
  }

  async function runAll() {
    if (!user) {
      setTopLevelError('Not signed in.');
      return;
    }
    if (variants.length === 0) {
      setTopLevelError('Add at least one variant.');
      return;
    }
    if (taskKind === 'OCR' && !file) {
      setTopLevelError('Upload an image first.');
      return;
    }
    if (taskKind === 'REWRITE' && !recipePick) {
      setTopLevelError('Pick a recipe first.');
      return;
    }
    setTopLevelError(undefined);
    setRunId(undefined);
    setServerVariants([]);
    setPromotedId(undefined);
    try {
      let storagePath: string | null = null;
      if (taskKind === 'OCR') {
        setPhase('uploading');
        storagePath = await uploadBakeoffImage(user.id, file!);
      }
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
        {
          taskKind,
          inputRecipeId: taskKind === 'REWRITE' ? recipePick!.recipeId : null,
        },
      );
      try {
        if (taskKind === 'REWRITE') await kickRewrite();
        else await kickOcr();
      } catch (e) {
        // Worker not configured is a common local-dev case. Surface but
        // don't block — the cron tick will eventually pick it up if the
        // secret is set later.
        setTopLevelError(
          `Worker kick failed (${(e as Error).message}). Variants are queued; results will appear when the worker runs.`,
        );
      }
      setRunTaskKind(taskKind);
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
          <h1 className="text-2xl font-semibold">
            {taskKind === 'REWRITE' ? 'Rewrite bakeoff' : 'OCR bakeoff'}
          </h1>
          <p className="mt-1 text-sm text-stone-600">
            {taskKind === 'REWRITE'
              ? 'Race rewrite prompts + models against the same recipe. Promote a winner to make it the default for the Improve Instructions button.'
              : 'Race multiple prompts and models against the same photo. Promote a winner to make it the default for new imports.'}
          </p>
        </div>
        <Link to="/import" className="text-sm underline text-stone-700">
          ← Back to imports
        </Link>
      </header>

      <div className="flex gap-1 border-b border-stone-200 text-sm" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={taskKind === 'OCR'}
          onClick={() => switchTask('OCR')}
          className={
            taskKind === 'OCR'
              ? 'rounded-t border border-stone-200 border-b-white bg-white px-4 py-2 font-medium'
              : 'rounded-t px-4 py-2 text-stone-600 hover:text-stone-900'
          }
          data-testid="bakeoff-tab-ocr"
        >
          OCR import
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={taskKind === 'REWRITE'}
          onClick={() => switchTask('REWRITE')}
          className={
            taskKind === 'REWRITE'
              ? 'rounded-t border border-stone-200 border-b-white bg-white px-4 py-2 font-medium'
              : 'rounded-t px-4 py-2 text-stone-600 hover:text-stone-900'
          }
          data-testid="bakeoff-tab-rewrite"
        >
          Instruction rewrite
        </button>
      </div>

      {topLevelError && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {topLevelError}
        </div>
      )}

      {taskKind === 'OCR' ? (
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
      ) : (
        <section
          className="rounded-lg border border-stone-200 bg-white p-5 space-y-3"
          data-testid="bakeoff-recipe-picker"
        >
          <h2 className="text-lg font-semibold">1. Pick a recipe</h2>
          <p className="text-xs text-stone-500">
            We send each variant the recipe's current instructions and compare the rewrite
            quality. Your existing OCR API key is reused for the call.
          </p>
          <RecipePicker
            value={recipePick}
            onChange={setRecipePick}
          />
        </section>
      )}

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
          disabled={
            (taskKind === 'OCR' ? !file : !recipePick) ||
            phase === 'uploading' ||
            phase === 'starting'
          }
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
          taskKind={runTaskKind}
          promotedId={promotedId}
          onPromote={(id) => void promote(id)}
        />
      )}

      {okResults.length >= 2 && leftId && rightId && (
        <DiffSection
          results={okResults}
          taskKind={runTaskKind}
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
  taskKind,
  promotedId,
  onPromote,
}: {
  variants: readonly BakeoffVariantRow[];
  running: boolean;
  taskKind: TaskKind;
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
                    taskKind === 'REWRITE' ? (
                      <RewriteSummary drafts={v.drafts} />
                    ) : (
                      <DraftSummary drafts={(v.drafts ?? []) as ParsedRecipeDraft[]} />
                    )
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

function RewriteSummary({ drafts }: { drafts: unknown }) {
  // REWRITE variants write `{ rewritten: [{ instructionId, simplifiedSteps[] }] }`
  // into bakeoff_variants.drafts. Show a short summary of how many
  // instructions got expanded and total atomic steps.
  const payload = drafts as { rewritten?: Array<{ simplifiedSteps?: unknown[] }> } | null;
  const entries = payload?.rewritten ?? [];
  const totalSteps = entries.reduce(
    (acc, e) => acc + (Array.isArray(e.simplifiedSteps) ? e.simplifiedSteps.length : 0),
    0,
  );
  return (
    <div className="text-xs">
      <div>
        {entries.length} {entries.length === 1 ? 'instruction' : 'instructions'} →{' '}
        {totalSteps} {totalSteps === 1 ? 'step' : 'steps'}
      </div>
    </div>
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
  taskKind,
  leftId,
  rightId,
  onLeft,
  onRight,
}: {
  results: ReadonlyArray<BakeoffVariantRow>;
  taskKind: TaskKind;
  leftId: string;
  rightId: string;
  onLeft: (id: string) => void;
  onRight: (id: string) => void;
}) {
  const left = results.find((r) => r.id === leftId);
  const right = results.find((r) => r.id === rightId);

  const diff = useMemo(() => {
    if (!left || !right) return [];
    if (taskKind === 'REWRITE') {
      const leftSummary = summarizeRewriteForDiff(left.drafts);
      const rightSummary = summarizeRewriteForDiff(right.drafts);
      return diffLines(leftSummary, rightSummary);
    }
    const leftDrafts = (left.drafts ?? []) as ParsedRecipeDraft[];
    const rightDrafts = (right.drafts ?? []) as ParsedRecipeDraft[];
    const leftSummary = leftDrafts[0] ? summarizeDraftForDiff(leftDrafts[0]) : '';
    const rightSummary = rightDrafts[0] ? summarizeDraftForDiff(rightDrafts[0]) : '';
    return diffLines(leftSummary, rightSummary);
  }, [left, right, taskKind]);

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

interface RecipePickEntry {
  collectionId: string;
  collectionTitle: string;
  recipeId: string;
  recipeTitle: string;
}

function RecipePicker({
  value,
  onChange,
}: {
  value: { collectionId: string; recipeId: string } | null;
  onChange: (next: { collectionId: string; recipeId: string } | null) => void;
}) {
  const { user } = useAuth();
  const { data: collectionsOptions = [] } = useCollectionPickerOptions();
  const [entries, setEntries] = useState<RecipePickEntry[]>([]);

  // Load (title, id) pairs for every collection the user has. We don't
  // hydrate full recipes — the bake-off only needs an id to start the
  // run; the worker re-reads instructions from Postgres anyway.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      const repo = collectionRepo(user.id);
      const acc: RecipePickEntry[] = [];
      for (const c of collectionsOptions) {
        try {
          const full = await repo.get(c.id);
          if (!full) continue;
          for (const r of full.recipes) {
            acc.push({
              collectionId: c.id,
              collectionTitle: c.title,
              recipeId: r.id,
              recipeTitle: r.title,
            });
          }
        } catch {
          // skip — collection might be in flux during pull
        }
      }
      if (!cancelled) setEntries(acc);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, collectionsOptions]);

  if (entries.length === 0) {
    return <p className="text-xs text-stone-500">No recipes available yet.</p>;
  }

  return (
    <select
      value={value ? `${value.collectionId}:${value.recipeId}` : ''}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) {
          onChange(null);
          return;
        }
        const [collectionId, recipeId] = v.split(':');
        if (!collectionId || !recipeId) return;
        onChange({ collectionId, recipeId });
      }}
      data-testid="bakeoff-recipe-select"
      className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
    >
      <option value="">— pick a recipe —</option>
      {entries.map((entry) => (
        <option
          key={`${entry.collectionId}:${entry.recipeId}`}
          value={`${entry.collectionId}:${entry.recipeId}`}
        >
          {entry.collectionTitle} · {entry.recipeTitle}
        </option>
      ))}
    </select>
  );
}
