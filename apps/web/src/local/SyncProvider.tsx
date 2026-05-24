import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider.js';
import { supabase } from '../supabase.js';
import { getLocalDb } from './db.js';
import { countPending } from './outbox.js';
import { pullAll, pushOutbox, subscribeRealtime, type RealtimeHandle } from './sync.js';

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

  async function cycle(ownerId: string) {
    if (inFlight.current) {
      pullPending.current = true;
      return inFlight.current;
    }
    const run = (async () => {
      setStatus('syncing');
      setLastError(null);
      try {
        // Push first so the pull sees our own changes reflected as
        // server-acknowledged state (avoids echo-induced overwrites).
        await pushOutbox(supabase, ownerId);
        await pullAll(supabase, ownerId);
        setLastSyncedAt(Date.now());
        setStatus('idle');
      } catch (err) {
        setLastError((err as Error).message);
        setStatus('error');
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
