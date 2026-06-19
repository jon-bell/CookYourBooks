import { useEffect, useState, useCallback } from 'react';
import type { ParsedRecipeDraft } from '@cookyourbooks/domain';
import { getLocalDb } from '../local/db.js';
import { useLocalDbReady } from '../local/SyncProvider.js';

export type RemixJobStatus = 'PENDING' | 'CLAIMED' | 'DONE' | 'FAILED';

export interface RemixJobSummary {
  id: string;
  status: RemixJobStatus;
  lastError: string | null;
  attempts: number;
  updatedAt: number;
  /**
   * The produced recipe draft, parsed from result_json. Only populated once
   * the job is DONE — the dialog promotes it into a brand-new recipe.
   */
  resultJson: ParsedRecipeDraft | null;
}

interface RemixJobLocalRow {
  id: string;
  status: string;
  last_error: string | null;
  attempts: number;
  updated_at: number;
  result_json: string | null;
}

async function fetchLatestJob(recipeId: string): Promise<RemixJobSummary | null> {
  const db = await getLocalDb();
  const rows = await db.execO<RemixJobLocalRow>(
    `select id, status, last_error, attempts, updated_at, result_json
       from remix_jobs
       where recipe_id = ? and (deleted is null or deleted = 0)
       order by updated_at desc, id desc
       limit 1`,
    [recipeId],
  );
  const row = rows[0];
  if (!row) return null;
  const status = (row.status as RemixJobStatus) ?? 'PENDING';
  // Parse the draft only when DONE — keeps the 1s poll cheap and avoids
  // churning on partial rows.
  let resultJson: ParsedRecipeDraft | null = null;
  if (status === 'DONE' && row.result_json) {
    try {
      resultJson = JSON.parse(row.result_json) as ParsedRecipeDraft;
    } catch {
      resultJson = null;
    }
  }
  return {
    id: row.id,
    status,
    lastError: row.last_error ?? null,
    attempts: row.attempts ?? 0,
    updatedAt: row.updated_at ?? 0,
    resultJson,
  };
}

/**
 * Reactive view of the latest remix_jobs row for a given recipe. Mirrors
 * useRewriteJob, but additionally exposes the produced draft (result_json)
 * so the dialog can promote it once DONE.
 *
 * Reads once on mount, then polls (1s) ONLY while a job is in flight
 * (PENDING/CLAIMED) — i.e. the user started a remix and is waiting on the
 * result. No poll runs in the steady state (same single-connection
 * contention fix as useRewriteJob). Returns `undefined` while loading.
 */
export function useRemixJob(recipeId: string | undefined): {
  job: RemixJobSummary | null | undefined;
  refresh: () => Promise<void>;
} {
  const ready = useLocalDbReady();
  const [job, setJob] = useState<RemixJobSummary | null | undefined>(undefined);

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
