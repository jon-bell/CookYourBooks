/**
 * Cross-tab leader election via the Web Locks API.
 *
 * Multiple tabs on the same origin share one cr-sqlite IndexedDB
 * (`idb-batch-atomic`). Each tab running its own sync cycle in parallel
 * can wedge the shared backing store: a 200-item write batch in tab A
 * blocks tab B's open/queries indefinitely. To prevent that, exactly
 * one tab at a time holds the `cookyourbooks-sync-leader` lock and is
 * the only one that pushes/pulls/subscribes to realtime. The rest
 * still read from local SQLite, just without writing.
 *
 * Leadership is held for the tab's lifetime — the lock is acquired via
 * `navigator.locks.request(name, cb)` where the callback returns a
 * promise that never resolves. When the tab is closed or the lock is
 * forcibly released (via `releaseLeadership`), the browser hands it to
 * whichever tab is next in the queue and that tab becomes the leader.
 *
 * Browsers without Web Locks API support (very old) get auto-elected
 * leader; multi-tab will fall back to the pre-fix behavior on those.
 */

import { logSync } from './syncLog.js';

const LEADER_LOCK_NAME = 'cookyourbooks-sync-leader';

export type TabRole = 'pending' | 'leader' | 'follower';

let role: TabRole = 'pending';
let releaseHeld: (() => void) | null = null;
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
 * Kick off leader election. Resolves immediately (the lock acquisition
 * happens in the background). Idempotent — calling more than once is
 * a no-op so it's safe to drop into a React effect.
 */
export function ensureLeaderElection(): void {
  if (initOnce) return;
  initOnce = true;
  if (typeof navigator === 'undefined' || !navigator.locks) {
    logSync('warn', 'navigator.locks unavailable — treating tab as leader');
    setRole('leader');
    return;
  }
  // We don't await this — the .request resolves only when the
  // callback's returned promise resolves, which we keep pending for
  // the tab's lifetime.
  void navigator.locks
    .request(LEADER_LOCK_NAME, () => {
      setRole('leader');
      return new Promise<void>((resolve) => {
        // Held until releaseLeadership() is called or the tab closes.
        releaseHeld = () => {
          releaseHeld = null;
          resolve();
        };
      });
    })
    .catch((err: unknown) => {
      logSync('error', 'leader election failed', {
        error: (err as Error)?.message ?? String(err),
      });
      // Fall back to leader so we don't strand the user.
      setRole('leader');
    });

  // Until the lock is awarded, we are a follower. The transition to
  // 'leader' happens inside the callback above. queryLeader periodically
  // tells us if we're still a follower (no transition pending) so we
  // can flip to 'follower' once the first poll confirms another tab
  // holds the lock.
  void confirmFollowerIfNotLeaderYet();
}

async function confirmFollowerIfNotLeaderYet(): Promise<void> {
  // Yield to the microtask queue so the leader callback above gets a
  // shot at running first when this tab is alone on the origin.
  await Promise.resolve();
  if (role === 'leader') return;
  try {
    const query = await navigator.locks.query();
    const held = query.held ?? [];
    const heldByOther = held.some((l) => l.name === LEADER_LOCK_NAME);
    if (heldByOther) setRole('follower');
  } catch {
    /* navigator.locks.query unsupported on some browsers — leave as pending */
  }
}

/**
 * Voluntarily release leadership so another tab can take over.
 * Used by the diagnostics panel's "Make this tab active" action.
 */
export function releaseLeadership(): void {
  if (releaseHeld) {
    logSync('info', 'releasing leadership voluntarily');
    releaseHeld();
    setRole('follower');
    // Re-enter the queue so we can pick it up again if no one else does.
    initOnce = false;
    ensureLeaderElection();
  }
}
