import { useState } from 'react';

import { OcrWorkerNotConfiguredError } from '../import/api.js';
import { type CoverScope, generateCovers } from '../recipe/coverApi.js';

/**
 * Enqueue Gemini cover generation for a scope (a collection or the whole
 * library) and kick the worker. Shows a transient queued/empty/error message;
 * the covers themselves stream back in via sync as the worker drains the queue.
 */
export function GenerateCoversButton({
  scope,
  targetId,
  label = 'Generate covers',
}: {
  scope: CoverScope;
  targetId?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const queued = await generateCovers(scope, targetId);
      setStatus(
        queued > 0
          ? `Queued ${queued} cover${queued === 1 ? '' : 's'} — they'll appear as the worker finishes.`
          : 'No recipes needed a cover job.',
      );
    } catch (e) {
      if (e instanceof OcrWorkerNotConfiguredError) setError(e.message);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        onClick={run}
        disabled={busy}
        className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
      >
        ✨ {busy ? 'Queuing…' : label}
      </button>
      {status && <span className="text-xs text-stone-500 dark:text-stone-400">{status}</span>}
      {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}
    </span>
  );
}
