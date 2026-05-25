import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider.js';
import { supabase } from '../supabase.js';
import { getLocalDb } from './db.js';
import { countPending } from './outbox.js';
import { pullAll, pushOutbox, subscribeRealtime, type RealtimeHandle } from './sync.js';

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
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
  /** Trigger an immediate pull + push cycle. Safe to call concurrently — overlapping calls coalesce. */
  syncNow: () => Promise<void>;
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

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState<SyncStatus>('initializing');
  const [localReady, setLocalReady] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [pendingWrites, setPendingWrites] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
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
    syncingStartedAt.current = Date.now();
    setStatus('syncing');
  }

  function setSettled(next: SyncStatus, error?: string) {
    syncingStartedAt.current = null;
    if (error !== undefined) setLastError(error);
    setStatus(next);
  }

  async function cycle(ownerId: string) {
    if (inFlight.current) {
      pullPending.current = true;
      return inFlight.current;
    }
    const run = (async () => {
      setSyncing();
      setLastError(null);
      try {
        // Push first so the pull sees our own changes reflected as
        // server-acknowledged state (avoids echo-induced overwrites).
        // Wrap in a hard timeout so a single hung request can't trap
        // the user on "Syncing…" forever — the actual fetch keeps
        // running, we just stop awaiting it.
        await withTimeout(pushOutbox(supabase, ownerId), CYCLE_TIMEOUT_MS, 'push');
        await withTimeout(pullAll(supabase, ownerId), CYCLE_TIMEOUT_MS, 'pull');
        setLastSyncedAt(Date.now());
        setSettled('idle');
      } catch (err) {
        setSettled('error', (err as Error).message);
      } finally {
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
          setLastError((err as Error).message);
        }
        return;
      }
      await refreshPendingCount();
      if (!cancelled) {
        setLocalReady(true);
        setStatus('idle');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // When the user changes, kick off an initial sync and open a realtime
  // channel to keep local in step with server-side changes.
  useEffect(() => {
    if (!user) {
      setHydrated(false);
      return;
    }
    let handle: RealtimeHandle | undefined;
    let cancelled = false;
    setHydrated(false);
    (async () => {
      await cycle(user.id);
      if (cancelled) return;
      setHydrated(true);
      handle = subscribeRealtime(supabase, user.id, {
        onLocalUpdate: scheduleInvalidate,
        onNeedsPull: () => schedulePull(user.id),
      });
    })();
    return () => {
      cancelled = true;
      void handle?.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

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
      // Clear inFlight so the next syncNow / realtime nudge can start
      // a fresh cycle instead of joining the wedged promise.
      inFlight.current = null;
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
    syncNow: async () => {
      if (user) await cycle(user.id);
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
