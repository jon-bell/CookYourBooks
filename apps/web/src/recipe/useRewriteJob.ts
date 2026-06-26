import { useCallback, useEffect, useState } from 'react';

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
 * Reads once on mount, then polls (1s) ONLY while `active` (the caller is
 * waiting on a job it just kicked off) OR a job is already in flight
 * (PENDING/CLAIMED). In the steady state there is no poll at all: the old
 * unconditional 1s timer fired on every open recipe page forever, and hundreds
 * of those reads piled up behind a wedged pull on the single cr-sqlite
 * connection.
 *
 * Why `active` and not just the observed status: `startRewrite` is an RPC that
 * creates the job server-side; the local PENDING row only appears a sync
 * round-trip later. So right after the user clicks, the local read still
 * returns null/the prior terminal job — there's nothing "in flight" to gate
 * on yet. The caller passes `active = true` while it's waiting (keyed to the
 * job it started), which bridges that gap; once the job lands and resolves,
 * the caller flips `active` off and polling stops. Returns `undefined` while
 * loading.
 */
export function useRewriteJob(
  recipeId: string | undefined,
  active = false,
): {
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

  // Poll while the caller is waiting on a just-started job (`active`) or a job
  // is already running.
  const inFlight = job?.status === 'PENDING' || job?.status === 'CLAIMED';
  useEffect(() => {
    if (!ready || !recipeId || (!active && !inFlight)) return;
    let cancelled = false;
    const interval = setInterval(() => {
      if (!cancelled) void refresh();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [ready, recipeId, active, inFlight, refresh]);

  return { job, refresh };
}
