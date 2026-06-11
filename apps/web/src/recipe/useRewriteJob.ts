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
 * Polls cheaply (1s) since rewrite_jobs is sync'd via the realtime
 * subscription anyway — the poll exists only so the UI advances when
 * the local DB writes don't fire a global update (eg the user opened
 * the recipe page mid-job). Returns `undefined` while loading.
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

  useEffect(() => {
    if (!ready || !recipeId) return;
    let cancelled = false;
    void (async () => {
      const initial = await fetchLatestJob(recipeId);
      if (!cancelled) setJob(initial);
    })();
    const interval = setInterval(() => {
      if (!cancelled) void refresh();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [ready, recipeId, refresh]);

  return { job, refresh };
}
