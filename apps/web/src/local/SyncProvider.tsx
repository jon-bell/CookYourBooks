import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider.js';
import { supabase } from '../supabase.js';
import { getLocalDb } from './db.js';
import { countPending } from './outbox.js';
import {
  pullAll,
  pullNutritionEssentials,
  pushOutbox,
  subscribeRealtime,
  type RealtimeHandle,
} from './sync.js';
import { logSync } from './syncLog.js';
import { reportError } from '../sentry.js';
import {
  ensureLeaderElection,
  getTabRole,
  subscribeTabRole,
  type TabRole,
} from './tabLeader.js';

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof e.message === 'string' && e.message.length > 0) parts.push(e.message);
    if (typeof e.code === 'string') parts.push(`code=${e.code}`);
    if (typeof e.hint === 'string') parts.push(`hint=${e.hint}`);
    if (parts.length > 0) return parts.join(' · ');
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        // Preserve the original error so the outer catch can extract
        // shape (.message / .code / .hint on PostgrestErrors, etc).
        // Earlier this wrapped non-Errors in `new Error(String(e))`,
        // which collapses an object into "[object Object]" and hides
        // what actually went wrong.
        reject(e);
      },
    );
  });
}

export type SyncStatus = 'initializing' | 'idle' | 'syncing' | 'error' | 'offline';

interface SyncState {
  status: SyncStatus;
  /** SQLite is open; false only during first boot. */
  localReady: boolean;
  /** First sync cycle for the signed-in user has finished. */
  hydrated: boolean;
  /** @deprecated Prefer {@link localReady} or query `isLoading`. True once DB is open and the first pull finished (signed-in only). */
  isLocalReady: boolean;
  pendingWrites: number;
  lastSyncedAt: number | null;
  lastError: string | null;
  /** Wall-clock when the current 'syncing' cycle started, or null. */
  syncingSince: number | null;
  /**
   * Cross-tab role. Only the leader runs sync cycles + realtime; other
   * tabs read from local SQLite but skip writes/network to avoid
   * wedging the shared IndexedDB backing store.
   */
  tabRole: TabRole;
  /** Trigger an immediate pull + push cycle. Safe to call concurrently — overlapping calls coalesce. */
  syncNow: () => Promise<void>;
  /**
   * Flush the outbox directly, bypassing `cycle()`'s in-flight gate.
   * Use when a server-side action needs to see a locally-enqueued row
   * *now* and can't tolerate the race where syncNow returns an
   * in-flight cycle that already started its push before the new
   * outbox entry was added (e.g. ImportBakeoffNewPage seeding variants
   * for a freshly-uploaded batch).
   */
  flushOutbox: () => Promise<void>;
}

const SyncContext = createContext<SyncState | undefined>(undefined);

const INVALIDATE_DEBOUNCE_MS = 100;
const PULL_DEBOUNCE_MS = 2000;
// Hard cap on a single sync cycle. If something hangs (a long-tail
// fetch never resolving, supabase-js stalling around token refresh,
// etc.) we abort the await chain so the badge can leave "Syncing…"
// and the user can retry. The actual network requests don't get
// cancelled — we just stop waiting on them.
const CYCLE_TIMEOUT_MS = 45_000;
// How often the watchdog checks for a wedged status. The boot UX is
// "page reload always fixes it", which is exactly the symptom of a
// dangling 'syncing' setState that no one comes back to clear. The
// watchdog gives us a recovery path without a reload.
const WATCHDOG_INTERVAL_MS = 5_000;
// Co-members' libraries (other people's content) have no reliable
// per-row realtime signal — a recipe someone adds to an already-shared
// collection doesn't change any row we're subscribed to. So while we're
// in a household we poll on a slow cadence (and on tab focus) to pull
// their new content. Cheap: an incremental watermark pull returns
// nothing when nothing changed.
const HOUSEHOLD_POLL_MS = 30_000;

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState<SyncStatus>('initializing');
  const [localReady, setLocalReady] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [pendingWrites, setPendingWrites] = useState(0);
  const [syncingSince, setSyncingSince] = useState<number | null>(null);
  const [tabRole, setTabRole] = useState<TabRole>(() => getTabRole());
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const currentAbort = useRef<AbortController | null>(null);
  const pullPending = useRef(false);
  const pullDebounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Wall-clock when status was most recently set to 'syncing'. Used by
  // the watchdog to detect a wedged state where the IIFE never reaches
  // its own finally (network hang, supabase-js auth queue stuck, etc).
  const syncingStartedAt = useRef<number | null>(null);

  function scheduleInvalidate() {
    clearTimeout(invalidateTimer.current);
    invalidateTimer.current = setTimeout(() => {
      // Full `collections` hydration is very expensive (every recipe in every
      // collection). Pull already updated SQLite; refetch picker/import keys only.
      void qc.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== 'collections',
      });
    }, INVALIDATE_DEBOUNCE_MS);
  }

  async function refreshPendingCount() {
    try {
      setPendingWrites(await countPending());
    } catch {
      /* outbox not ready yet */
    }
  }

  function setSyncing() {
    const now = Date.now();
    syncingStartedAt.current = now;
    setSyncingSince(now);
    setStatus('syncing');
  }

  function setSettled(next: SyncStatus, error?: string) {
    syncingStartedAt.current = null;
    setSyncingSince(null);
    if (error !== undefined) setLastError(error);
    setStatus(next);
  }

  const householdIdRef = useRef<string | null>(null);

  async function cycle(ownerId: string) {
    if (inFlight.current) {
      pullPending.current = true;
      logSync('info', 'cycle: coalesced into in-flight run');
      return inFlight.current;
    }
    const ac = new AbortController();
    currentAbort.current = ac;
    const run = (async () => {
      const cycleStart = Date.now();
      logSync('info', 'cycle: start');
      setSyncing();
      setLastError(null);
      try {
        // Push first so the pull sees our own changes reflected as
        // server-acknowledged state (avoids echo-induced overwrites).
        // Wrap in a hard timeout so a single hung request can't trap
        // the user on "Syncing…" forever — when the timeout fires we
        // also abort the AbortController so the inner drain loop
        // bails out instead of continuing to hit the network behind
        // our back (which would race a later cycle and trip
        // duplicate-key / FK violations on recipe pushes).
        logSync('info', 'cycle: invoking pushOutbox');
        const pushRes = await withTimeout(
          pushOutbox(supabase, ownerId, ac.signal),
          CYCLE_TIMEOUT_MS,
          'push',
          () => ac.abort(),
        );
        logSync('info', 'cycle: pushOutbox returned', pushRes);
        logSync('info', 'cycle: invoking pullAll');
        const pullRes = await withTimeout(
          pullAll(supabase, ownerId, ac.signal, {
            // Invalidate React Query incrementally so the library card
            // grid hydrates the moment recipes land, instead of waiting
            // for imports / conversion_rules / rewrite_jobs to finish.
            // Skip the 'collections' key from each invalidate (it's
            // expensive — see scheduleInvalidate predicate).
            onPhaseComplete: () => scheduleInvalidate(),
          }),
          CYCLE_TIMEOUT_MS,
          'pull',
          () => ac.abort(),
        );
        householdIdRef.current = pullRes.householdId;
        logSync('info', 'cycle: pullAll returned');
        // Fire-and-forget: reference data doesn't gate the UI, and
        // failures shouldn't show up as a sync error to the user.
        // Throttled internally — only refetches once a month.
        pullNutritionEssentials(supabase).catch((err) => {
          logSync('warn', 'nutrition essentials pull failed', { error: stringifyError(err) });
        });
        setLastSyncedAt(Date.now());
        setSettled('idle');
        logSync('info', `cycle: idle (took ${Date.now() - cycleStart}ms)`);
      } catch (err) {
        // Some thrown values (notably PostgrestError-shaped objects)
        // aren't Error instances, so `.message` is undefined and the
        // badge ends up showing "[object Object]". Stringify whatever
        // we got and prefer fields commonly populated by errors.
        const msg = stringifyError(err);
        // Dump the raw shape to the console so a debug session can see
        // what actually came back — useful when the stringified version
        // collapses an interesting object into something like
        // "PostgrestError" with no hint of the underlying cause.
        console.error('[sync] cycle threw:', err);
        setSettled('error', msg);
        logSync('error', `cycle: error after ${Date.now() - cycleStart}ms`, { error: msg });
        // The cycle catch only sees pull / cycle-timeout failures (pushOutbox
        // handles its own per-entry errors internally). Report them so prod
        // sync stalls — e.g. a pull statement timing out — are visible.
        reportError(err, { operation: 'sync_cycle' });
      } finally {
        if (currentAbort.current === ac) currentAbort.current = null;
        await refreshPendingCount();
        scheduleInvalidate();
      }
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
      if (pullPending.current) {
        pullPending.current = false;
        void cycle(ownerId);
      }
    }
  }

  function schedulePull(ownerId: string) {
    clearTimeout(pullDebounceTimer.current);
    pullDebounceTimer.current = setTimeout(() => {
      void cycle(ownerId);
    }, PULL_DEBOUNCE_MS);
  }

  // Boot: ensure the local DB is ready before any page tries to read.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getLocalDb();
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setLastError(stringifyError(err));
        }
        return;
      }
      await refreshPendingCount();
      if (!cancelled) {
        setLocalReady(true);
        // Only flip to 'idle' if no cycle has already moved us to
        // 'syncing'. Without this, db init resolving AFTER the cycle
        // started (cycle awaits the same getLocalDb promise) lets the
        // boot effect clobber status back to 'idle' mid-pull — the
        // badge says "Synced" while pull is still draining and other
        // pages contend on the SQLite mutex.
        setStatus((s) => (s === 'initializing' ? 'idle' : s));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Kick off cross-tab leader election. Subscribe so role changes
  // (e.g. another tab closing makes us the leader) are reflected.
  useEffect(() => {
    ensureLeaderElection();
    setTabRole(getTabRole());
    const unsub = subscribeTabRole(setTabRole);
    return unsub;
  }, []);

  // When the user changes (or we become the leader), kick off an
  // initial sync and open a realtime channel. Follower tabs skip both
  // — they read from local SQLite but the leader is the sole writer
  // and the sole realtime listener (avoids two tabs racing on the
  // shared IDB and on Supabase row events).
  useEffect(() => {
    if (!user) {
      setHydrated(false);
      return;
    }
    if (tabRole !== 'leader') {
      logSync('info', `skipping sync cycle: tab role is ${tabRole}`);
      // Followers still count as hydrated for the UI gate — the
      // existing local cache from a prior session is good enough.
      setHydrated(true);
      return;
    }
    let handle: RealtimeHandle | undefined;
    let cancelled = false;
    setHydrated(false);
    (async () => {
      await cycle(user.id);
      if (cancelled) return;
      setHydrated(true);
      handle = subscribeRealtime(
        supabase,
        user.id,
        {
          onLocalUpdate: scheduleInvalidate,
          onNeedsPull: () => schedulePull(user.id),
        },
        householdIdRef.current,
      );
    })();
    return () => {
      cancelled = true;
      void handle?.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, tabRole]);

  // Poll for co-members' new content while in a household: re-pull on
  // tab focus and on a slow interval. This is what makes a recipe a
  // co-member adds *after* sharing show up without a manual refresh —
  // there's no per-row realtime event we can subscribe to for it.
  useEffect(() => {
    if (!user || tabRole !== 'leader') return;
    const ownerId = user.id;
    function repullHousehold() {
      if (!householdIdRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void cycle(ownerId);
    }
    window.addEventListener('focus', repullHousehold);
    document.addEventListener('visibilitychange', repullHousehold);
    const poll = setInterval(repullHousehold, HOUSEHOLD_POLL_MS);
    return () => {
      window.removeEventListener('focus', repullHousehold);
      document.removeEventListener('visibilitychange', repullHousehold);
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, tabRole]);

  useEffect(
    () => () => {
      clearTimeout(invalidateTimer.current);
      clearTimeout(pullDebounceTimer.current);
    },
    [],
  );

  // Watchdog: if status has been 'syncing' for longer than the cycle
  // timeout, force-recover. The withTimeout inside cycle already
  // guards the awaited path, but this catches state-machine bugs
  // where setStatus('syncing') was issued and the matching settle
  // never landed (e.g., an aborted effect that left the badge stale).
  useEffect(() => {
    if (status !== 'syncing') return;
    const tick = setInterval(() => {
      const startedAt = syncingStartedAt.current;
      if (!startedAt) return;
      if (Date.now() - startedAt <= CYCLE_TIMEOUT_MS) return;
      // Clear inFlight AND abort the cycle's signal so the inner
      // drain loop bails. Without the abort, the in-flight pushOutbox
      // / pullAll keep running in the background and race against the
      // next cycle (concurrent recipe pushes manifested as duplicate
      // PK / FK violations on instruction_ingredient_refs).
      currentAbort.current?.abort();
      inFlight.current = null;
      logSync('error', 'watchdog: cycle stalled, aborting + clearing inFlight');
      setSettled(
        'error',
        'Sync stalled — click "Syncing…" or refresh to retry.',
      );
    }, WATCHDOG_INTERVAL_MS);
    return () => clearInterval(tick);
  }, [status]);

  // Online/offline transitions trigger a catch-up sync.
  useEffect(() => {
    if (!user) return;
    function onOnline() {
      void cycle(user!.id);
    }
    function onOffline() {
      setStatus('offline');
    }
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const isLocalReady = localReady && (!user || hydrated);

  const value: SyncState = {
    status,
    localReady,
    hydrated,
    isLocalReady,
    pendingWrites,
    lastSyncedAt,
    lastError,
    syncingSince,
    tabRole,
    syncNow: async () => {
      if (!user) return;
      if (tabRole !== 'leader') {
        logSync('warn', 'syncNow ignored: this tab is not the sync leader');
        return;
      }
      await cycle(user.id);
    },
    flushOutbox: async () => {
      if (!user) return;
      if (tabRole !== 'leader') {
        logSync('warn', 'flushOutbox ignored: this tab is not the sync leader');
        return;
      }
      try {
        await pushOutbox(supabase, user.id);
      } finally {
        await refreshPendingCount();
      }
    },
  };

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncState {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within SyncProvider');
  return ctx;
}

/** Gate for React Query hooks that read the local SQLite cache (no initial-sync wait). */
export function useLocalQueryEnabled(): boolean {
  return useLocalDbReady();
}

/** Gate for lightweight reads once SQLite is open (no initial sync wait). */
export function useLocalDbReady(): boolean {
  const { user } = useAuth();
  const { localReady } = useSync();
  return !!user && localReady;
}
