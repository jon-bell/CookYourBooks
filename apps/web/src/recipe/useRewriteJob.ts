import { useEffect, useState, useCallback } from 'react';
import { getLocalDb } from '../local/db.js';
import { useLocalDbReady } from '../local/SyncProvider.js';

export type RewriteJobStatus = 'PENDING' | 'CLAIMED' | 'DONE' | 'FAILED';

export interface RewriteJobSummary {
  id: string;
  status: RewriteJobStatus;
  lastError: string | null;
  attempts: number;
  updatedAt: number;
}

interface RewriteJobLocalRow {
  id: string;
  status: string;
  last_error: string | null;
  attempts: number;
  updated_at: number;
}

async function fetchLatestJob(recipeId: string): Promise<RewriteJobSummary | null> {
  const db = await getLocalDb();
  const rows = await db.execO<RewriteJobLocalRow>(
    `select id, status, last_error, attempts, updated_at
       from rewrite_jobs
       where recipe_id = ? and (deleted is null or deleted = 0)
       order by updated_at desc, id desc
       limit 1`,
    [recipeId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: (row.status as RewriteJobStatus) ?? 'PENDING',
    lastError: row.last_error ?? null,
    attempts: row.attempts ?? 0,
    updatedAt: row.updated_at ?? 0,
  };
}

/**
 * Reactive view of the latest rewrite_jobs row for a given recipe.
 *
 * Reads once on mount, then polls (1s) ONLY while a job is in flight
 * (PENDING/CLAIMED) — i.e. the user kicked off a rewrite and is waiting on
 * the result. In the steady state (no job, or a terminal one) there is no
 * poll at all: the old unconditional 1s timer fired on every open recipe page
 * forever, and hundreds of those reads piled up behind a wedged pull on the
 * single cr-sqlite connection. `startImprove` calls `refresh()` after
 * enqueuing, which flips `job` to PENDING and starts the poll; it stops as
 * soon as the job reaches DONE/FAILED. Returns `undefined` while loading.
 */
export function useRewriteJob(recipeId: string | undefined): {
  job: RewriteJobSummary | null | undefined;
  refresh: () => Promise<void>;
} {
  const ready = useLocalDbReady();
  const [job, setJob] = useState<RewriteJobSummary | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!recipeId) {
      setJob(null);
      return;
    }
    try {
      const next = await fetchLatestJob(recipeId);
      setJob(next);
    } catch {
      // Local DB hiccup — keep the previous value rather than churning UI.
    }
  }, [recipeId]);

  // One read on mount / recipe change to establish initial state.
  useEffect(() => {
    if (!ready || !recipeId) {
      setJob(recipeId ? undefined : null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const initial = await fetchLatestJob(recipeId);
      if (!cancelled) setJob(initial);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, recipeId]);

  // Poll only while the job is actually running.
  const inFlight = job?.status === 'PENDING' || job?.status === 'CLAIMED';
  useEffect(() => {
    if (!ready || !recipeId || !inFlight) return;
    let cancelled = false;
    const interval = setInterval(() => {
      if (!cancelled) void refresh();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [ready, recipeId, inFlight, refresh]);

  return { job, refresh };
}
