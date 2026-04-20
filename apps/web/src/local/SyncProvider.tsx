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
  pendingWrites: number;
  lastSyncedAt: number | null;
  lastError: string | null;
  /** Trigger an immediate pull + push cycle. Safe to call concurrently — overlapping calls coalesce. */
  syncNow: () => Promise<void>;
}

const SyncContext = createContext<SyncState | undefined>(undefined);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState<SyncStatus>('initializing');
  const [pendingWrites, setPendingWrites] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  async function refreshPendingCount() {
    try {
      setPendingWrites(await countPending());
    } catch {
      /* outbox not ready yet */
    }
  }

  async function cycle(ownerId: string) {
    if (inFlight.current) return inFlight.current;
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
        qc.invalidateQueries();
      }
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
    }
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
      if (!cancelled) setStatus('idle');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // When the user changes, kick off an initial sync and open a realtime
  // channel to keep local in step with server-side changes.
  useEffect(() => {
    if (!user) return;
    let handle: RealtimeHandle | undefined;
    let cancelled = false;
    (async () => {
      await cycle(user.id);
      if (cancelled) return;
      handle = subscribeRealtime(supabase, user.id, () => {
        // Pull again to capture any cascading changes (e.g. ingredients
        // referenced by the realtime-updated recipe).
        void cycle(user.id);
      });
    })();
    return () => {
      cancelled = true;
      void handle?.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

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

  const value: SyncState = {
    status,
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
