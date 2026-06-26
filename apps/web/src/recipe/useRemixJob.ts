import type { ParsedRecipeDraft } from '@cookyourbooks/domain';
import { useCallback, useEffect, useState } from 'react';

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
 * Reads once on mount, then polls (1s) ONLY while `active` (the caller is
 * waiting on a remix it just started) OR a job is already in flight
 * (PENDING/CLAIMED). No poll runs in the steady state. `active` bridges the
 * gap between the user clicking and the local PENDING row syncing down (the
 * job is created by an RPC, so it isn't observable locally at click time) —
 * see useRewriteJob for the full rationale. Returns `undefined` while loading.
 */
export function useRemixJob(
  recipeId: string | undefined,
  active = false,
): {
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
