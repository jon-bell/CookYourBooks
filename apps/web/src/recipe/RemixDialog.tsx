import type { ParsedRecipeDraft, Recipe } from '@cookyourbooks/domain';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { useCollectionPickerOptions, useSaveRecipe } from '../data/queries.js';
import {
  cancelRemix,
  getUserRemixPrefs,
  kickRemix,
  OcrWorkerNotConfiguredError,
  startRemix,
} from '../import/api.js';
import { buildRecipeFromDraft } from '../import/promoteDraft.js';
import {
  DEFAULT_REMIX_MODEL_BY_PROVIDER,
  DEFAULT_REMIX_PROMPT,
} from '../settings/remixSettings.js';
import { recipeToRemixInput } from './recipeToRemixInput.js';
import { useRemixJob } from './useRemixJob.js';

const inputCls =
  'w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-3 py-2 text-sm';

const PRESETS = [
  'Make it a sheet-pan dinner',
  'Make it vegetarian',
  'Swap the main protein',
  'Halve the recipe',
  'Make it gluten-free',
];

interface Turn {
  instruction: string;
  status: 'working' | 'done' | 'failed';
  draft?: ParsedRecipeDraft;
  error?: string;
}

/**
 * Recipe Remix dialog. A short conversation: the user types a freeform
 * transformation, the LLM returns a new recipe draft (preview), and they can
 * send follow-ups to refine, start over, or save the result as a new recipe.
 * Hand-rolled overlay matching the app's dialog convention (no Radix).
 */
export function RemixDialog({
  recipe,
  collectionId,
  onClose,
  onSaved,
}: {
  recipe: Recipe;
  collectionId: string;
  onClose: () => void;
  onSaved: (newRecipeId: string, destCollectionId: string) => void;
}) {
  const qc = useQueryClient();
  const [instruction, setInstruction] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  // The current working recipe: null means "the original". Each DONE turn
  // replaces it; "Start over" resets it to null.
  const [workingDraft, setWorkingDraft] = useState<ParsedRecipeDraft | null>(null);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  const { job, refresh } = useRemixJob(recipe.id);

  // Owned collections only (the import picker is owner-scoped) — used to
  // decide where the saved copy lands. Own recipe → same collection;
  // a co-member's shared recipe → the user's own default collection.
  const { data: owned = [] } = useCollectionPickerOptions();
  const { destId, destTitle, currentIsOwned } = useMemo(() => {
    const isOwned = owned.some((o) => o.id === collectionId);
    if (isOwned) {
      return { destId: collectionId, destTitle: undefined, currentIsOwned: true };
    }
    const fallback = owned.find((o) => o.sourceType === 'PERSONAL') ?? owned[0];
    return { destId: fallback?.id, destTitle: fallback?.title, currentIsOwned: false };
  }, [owned, collectionId]);

  const saveRecipe = useSaveRecipe(destId ?? collectionId);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Consume the in-flight job once it reaches a terminal state.
  useEffect(() => {
    if (!pendingJobId || !job || job.id !== pendingJobId) return;
    if (job.status === 'DONE' && job.resultJson) {
      const draft = job.resultJson;
      setWorkingDraft(draft);
      setTurns((prev) => updateLast(prev, { status: 'done', draft }));
      setPendingJobId(null);
    } else if (job.status === 'FAILED') {
      setTurns((prev) =>
        updateLast(prev, { status: 'failed', error: job.lastError ?? 'Remix failed.' }),
      );
      setPendingJobId(null);
    }
  }, [job, pendingJobId]);

  const busy = pendingJobId !== null;

  async function runTurn(instr: string) {
    const text = instr.trim();
    if (!text || busy) return;
    setError(undefined);
    setInstruction('');
    setTurns((prev) => [...prev, { instruction: text, status: 'working' }]);
    try {
      const prefs = await getUserRemixPrefs().catch(() => null);
      const provider = prefs?.provider ?? 'gemini';
      // The working recipe to transform: the prior draft on follow-ups, else
      // the original recipe. Always a JSON object (worker requires it).
      const inputRecipeJson = recipeToRemixInput(workingDraft ?? recipe);
      const jobId = await startRemix({
        recipeId: recipe.id,
        provider,
        model: prefs?.model || DEFAULT_REMIX_MODEL_BY_PROVIDER[provider],
        prompt: prefs?.prompt || DEFAULT_REMIX_PROMPT,
        instruction: text,
        inputRecipeJson,
      });
      setPendingJobId(jobId);
      // Best-effort kick — the cron tick also drains the queue within 30s.
      try {
        await kickRemix(recipe.id);
      } catch (err) {
        if (err instanceof OcrWorkerNotConfiguredError) {
          setError(err.message);
        }
        // Otherwise non-fatal: the job is queued, cron will pick it up.
      }
      await refresh();
    } catch (err) {
      setTurns((prev) => updateLast(prev, { status: 'failed', error: (err as Error).message }));
      setPendingJobId(null);
      setError((err as Error).message);
    }
  }

  async function startOver() {
    if (busy && pendingJobId) {
      try {
        await cancelRemix(pendingJobId);
      } catch {
        // best effort
      }
    }
    setTurns([]);
    setWorkingDraft(null);
    setPendingJobId(null);
    setError(undefined);
    setInstruction('');
  }

  async function save() {
    if (!workingDraft || !destId) return;
    const remixNote = `Remixed: ${turns
      .filter((t) => t.status === 'done')
      .map((t) => t.instruction)
      .join('; ')}`;
    const built = buildRecipeFromDraft(workingDraft, { parentRecipeId: recipe.id });
    const newRecipe: Recipe = { ...built, notes: remixNote };
    await saveRecipe.mutateAsync(newRecipe);
    // useSaveRecipe invalidates but doesn't await the refetch; force it so the
    // destination collection contains the new recipe before we navigate.
    await qc.refetchQueries({ queryKey: ['collection', destId] });
    onSaved(newRecipe.id, destId);
  }

  const hasPreview = workingDraft !== null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Remix recipe"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-950/60 p-4"
      onClick={onClose}
    >
      <div
        className="mt-12 w-full max-w-2xl rounded-lg border border-stone-200 bg-white p-5 shadow-xl dark:border-stone-700 dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
        data-testid="remix-dialog"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Remix recipe</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
          >
            Close (esc)
          </button>
        </div>
        <p className="mt-0.5 text-sm text-stone-500">{recipe.title}</p>

        {error && (
          <div
            role="alert"
            className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
            data-testid="remix-error"
          >
            {error}
          </div>
        )}

        {/* Conversation history */}
        {turns.length > 0 && (
          <ol className="mt-4 space-y-2" data-testid="remix-turns">
            {turns.map((t, i) => (
              <li key={i} className="rounded-md bg-stone-50 dark:bg-stone-800/50 px-3 py-2 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{t.instruction}</span>
                  <span className="shrink-0 text-xs text-stone-500" data-testid="remix-status">
                    {t.status === 'working' && 'Remixing…'}
                    {t.status === 'done' && '✓ Done'}
                    {t.status === 'failed' && '✗ Failed'}
                  </span>
                </div>
                {t.status === 'failed' && t.error && (
                  <p className="mt-1 text-xs text-red-700 dark:text-red-300">{t.error}</p>
                )}
              </li>
            ))}
          </ol>
        )}

        {/* Preview of the current working recipe */}
        {hasPreview && workingDraft && (
          <div
            className="mt-4 rounded-md border border-stone-200 dark:border-stone-700 p-4"
            data-testid="remix-preview"
          >
            <h4 className="text-base font-semibold" data-testid="remix-preview-title">
              {workingDraft.title?.trim() || 'Untitled remix'}
            </h4>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                  Ingredients ({workingDraft.ingredients.length})
                </p>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {recipeToRemixInput(workingDraft)
                    .ingredients.slice(0, 12)
                    .map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                </ul>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                  Steps ({workingDraft.instructions.length})
                </p>
                <ol className="mt-1 list-decimal pl-5 text-sm">
                  {workingDraft.instructions.slice(0, 4).map((s, i) => (
                    <li key={i}>{s.text}</li>
                  ))}
                  {workingDraft.instructions.length > 4 && (
                    <li className="list-none text-stone-500">
                      +{workingDraft.instructions.length - 4} more…
                    </li>
                  )}
                </ol>
              </div>
            </div>
          </div>
        )}

        {/* Compose / follow-up box */}
        <div className="mt-4">
          <label className="block">
            <span className="text-sm font-medium">
              {hasPreview ? 'Refine further (optional)' : 'How should we remix this?'}
            </span>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={2}
              disabled={busy}
              placeholder={
                hasPreview
                  ? 'e.g. and make it gluten-free'
                  : 'e.g. make it a sheet-pan dinner, swap the beef for lamb'
              }
              className={`mt-1 ${inputCls}`}
              data-testid={hasPreview ? 'remix-followup' : 'remix-instruction'}
            />
          </label>
          {!hasPreview && (
            <div className="mt-2 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={busy}
                  onClick={() => setInstruction(p)}
                  className="rounded-full border border-stone-300 px-3 py-1 text-xs hover:bg-stone-100 disabled:opacity-50 dark:border-stone-600 dark:hover:bg-stone-800"
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>

        {!currentIsOwned && hasPreview && (
          <p className="mt-3 text-xs text-stone-500" data-testid="remix-dest">
            {destTitle
              ? `This isn't your recipe — the remix will be saved to your library: “${destTitle}”.`
              : 'Create a collection in your library first to save remixes.'}
          </p>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {turns.length > 0 && (
            <button
              type="button"
              onClick={startOver}
              disabled={busy}
              className="mr-auto rounded-md px-3 py-2 text-sm text-stone-700 hover:bg-stone-100 disabled:opacity-50 dark:text-stone-300 dark:hover:bg-stone-800"
              data-testid="remix-startover"
            >
              Start over
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void runTurn(instruction)}
            disabled={busy || !instruction.trim()}
            className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-600 dark:hover:bg-stone-800"
            data-testid="remix-run"
          >
            {busy ? 'Remixing…' : hasPreview ? 'Refine' : 'Remix'}
          </button>
          {hasPreview && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || saveRecipe.isPending || !destId}
              className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300"
              data-testid="remix-save"
            >
              Save as new recipe
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function updateLast(turns: Turn[], patch: Partial<Turn>): Turn[] {
  if (turns.length === 0) return turns;
  const next = turns.slice();
  next[next.length - 1] = { ...next[next.length - 1]!, ...patch };
  return next;
}
