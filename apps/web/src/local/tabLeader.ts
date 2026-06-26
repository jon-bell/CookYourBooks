/**
 * Cross-tab leader election via the Web Locks API.
 *
 * Multiple tabs on the same origin share one cr-sqlite IndexedDB
 * (`idb-batch-atomic`). Each tab running its own sync cycle in parallel
 * can wedge the shared backing store — a 200-item write batch in tab A
 * blocks tab B's open/queries indefinitely. To prevent that, exactly
 * one tab at a time holds the `cookyourbooks-sync-leader` lock and is
 * the only one that pushes/pulls/subscribes to realtime. The rest read
 * from local SQLite but skip writes/network.
 *
 * Leadership is held for the tab's lifetime — `navigator.locks.request`
 * runs its callback once the lock is awarded; the callback returns a
 * promise that never resolves so the lock stays held until the tab is
 * destroyed (or releaseLeadership() is called from the diagnostics
 * dialog).
 *
 * Browsers without Web Locks API support get auto-elected leader; the
 * legacy single-tab assumption applies on those.
 */

import { logSync } from './syncLog.js';

const LEADER_LOCK_NAME = 'cookyourbooks-sync-leader';

export type TabRole = 'pending' | 'leader' | 'follower';

let role: TabRole = 'pending';
let releaseHeld: (() => void) | null = null;
let pendingAbort: AbortController | null = null;
const subscribers = new Set<(role: TabRole) => void>();

function setRole(next: TabRole) {
  if (role === next) return;
  role = next;
  logSync('info', `tab role: ${next}`);
  for (const fn of subscribers) fn(next);
}

export function getTabRole(): TabRole {
  return role;
}

export function subscribeTabRole(fn: (role: TabRole) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

let initOnce = false;

/**
 * Kick off leader election. Returns immediately; the actual acquisition
 * happens in the background. Idempotent — calling more than once is a
 * no-op so it's safe to drop into a React effect.
 */
export function ensureLeaderElection(): void {
  if (initOnce) return;
  initOnce = true;
  if (typeof navigator === 'undefined' || !navigator.locks) {
    logSync('warn', 'navigator.locks unavailable — treating tab as leader');
    setRole('leader');
    return;
  }
  void runLeaderElection().catch((err: unknown) => {
    logSync('error', 'leader election crashed', {
      error: (err as Error)?.message ?? String(err),
    });
    // Fall back to leader so the app remains functional.
    setRole('leader');
  });
}

/**
 * Two-phase acquisition that avoids the race in our earlier query()
 * approach:
 *   1. `ifAvailable: true` tells us synchronously whether we got the
 *      lock. If the callback receives a non-null lock object, we are
 *      leader. If it's null, someone else holds it — we are follower.
 *   2. If not the leader, queue a normal (blocking) request that will
 *      run later when the current leader's tab is closed, at which
 *      point we promote ourselves.
 */
async function runLeaderElection(): Promise<void> {
  const abort = new AbortController();
  pendingAbort = abort;

  let acquired = false;
  await navigator.locks.request(LEADER_LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (lock) {
      acquired = true;
      setRole('leader');
      await new Promise<void>((resolve) => {
        releaseHeld = () => {
          releaseHeld = null;
          resolve();
        };
      });
    }
  });

  if (acquired) {
    // Lock was released (releaseLeadership / tab closing). Re-enter
    // the queue so we can pick it up again if no other tab grabbed it.
    logSync('info', 'leadership released; re-queuing');
    pendingAbort = null;
    initOnce = false;
    ensureLeaderElection();
    return;
  }

  // Someone else holds the lock right now. We're a follower; queue a
  // blocking request that will eventually award us the lock when the
  // current leader's tab is closed (or hands it over via
  // releaseLeadership). The signal lets forceReelect() abort the wait.
  setRole('follower');
  try {
    await navigator.locks.request(LEADER_LOCK_NAME, { signal: abort.signal }, async () => {
      setRole('leader');
      await new Promise<void>((resolve) => {
        releaseHeld = () => {
          releaseHeld = null;
          resolve();
        };
      });
    });
  } catch (err) {
    if (abort.signal.aborted) {
      logSync('info', 'follower wait aborted (force re-elect)');
      return;
    }
    throw err;
  }
  // If we get here, our held lock was released; re-enter the queue.
  logSync('info', 'leadership released (post-promotion); re-queuing');
  pendingAbort = null;
  initOnce = false;
  ensureLeaderElection();
}

/**
 * Voluntarily release leadership so another tab (or this one again
 * after a re-queue) can take over. Used by the diagnostics panel's
 * "Release leadership" action.
 */
export function releaseLeadership(): void {
  if (releaseHeld) {
    logSync('info', 'releasing leadership voluntarily');
    releaseHeld();
    // setRole is driven by the lock callback path; releaseHeld()
    // resolving makes runLeaderElection re-enter and re-acquire (or
    // become follower).
  } else {
    logSync('warn', 'releaseLeadership: no held lock to release');
  }
}

/**
 * Hard reset: drop any held lock, clear in-memory state, and start
 * election over. Used by the dialog's "Force re-elect" button to
 * recover from any wedged state.
 */
export function forceReelect(): void {
  logSync('warn', 'forceReelect: tearing down and re-electing');
  // Release a held lock (leader path) so the next runLeaderElection
  // can re-acquire it.
  if (releaseHeld) {
    releaseHeld();
  }
  // Cancel a pending follower wait so it doesn't sit there forever.
  if (pendingAbort && !pendingAbort.signal.aborted) {
    pendingAbort.abort();
  }
  pendingAbort = null;
  role = 'pending';
  for (const fn of subscribers) fn(role);
  initOnce = false;
  ensureLeaderElection();
}

/**
 * Diagnostic: peek at the current state of all Web Locks for this
 * origin. Used by the sync diagnostics panel so the user can see who
 * is holding the leader lock (and how many tabs are queued behind
 * it).
 */
export async function queryLeaderLockState(): Promise<{
  held: { name: string; clientId?: string; mode?: string }[];
  pending: { name: string; clientId?: string; mode?: string }[];
  supported: boolean;
}> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return { held: [], pending: [], supported: false };
  }
  try {
    const q = await navigator.locks.query();
    const filter = (
      arr: readonly { name?: string; clientId?: string; mode?: string }[] | undefined,
    ) =>
      (arr ?? [])
        .filter(
          (l): l is { name: string; clientId?: string; mode?: string } =>
            typeof l.name === 'string' && l.name === LEADER_LOCK_NAME,
        )
        .map((l) => ({ name: l.name, clientId: l.clientId, mode: l.mode }));
    return {
      held: filter(q.held),
      pending: filter(q.pending),
      supported: true,
    };
  } catch {
    return { held: [], pending: [], supported: true };
  }
}
