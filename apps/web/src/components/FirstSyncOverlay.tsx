import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import { isLocalLibraryEmpty } from '../local/repositories.js';
import { getSyncLog, subscribeSyncLog } from '../local/syncLog.js';
import { useSync } from '../local/SyncProvider.js';
import { LoadingOverlay } from './LoadingOverlay.js';

// Friendly phase line derived from the latest sync-log entry, so the wait shows
// real progress instead of a generic spinner.
function phaseLabel(): string {
  const log = getSyncLog();
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const m = log[i]!.message;
    if (m.startsWith('pull collections')) return 'Fetching your cookbooks…';
    if (m.startsWith('pull recipes')) return 'Fetching your recipes…';
    if (m.startsWith('pull ')) return 'Fetching shared content…';
    if (m.startsWith('push') || m.startsWith('cycle: invoking pushOutbox'))
      return 'Saving your changes…';
  }
  return 'Setting up your library…';
}

/**
 * Shown only when a signed-in leader tab has an empty local library that has
 * never finished a sync and a cycle is in flight — i.e. the user would
 * otherwise be staring at a blank screen while the first pull runs (the exact
 * state of the wedged-sync incident). Auto-dismisses once the first sync lands
 * or any content appears; offers Retry on error/timeout.
 */
export function FirstSyncOverlay() {
  const { user } = useAuth();
  const { status, localReady, lastSyncedAt, syncingSince, tabRole, lastError, syncNow } = useSync();
  // Real local-emptiness probe — runs as soon as the DB is open (not gated on
  // `hydrated`), so a returning user with existing data is correctly excluded
  // even though lastSyncedAt is null at the start of every session.
  const { data: emptyLibrary } = useQuery({
    queryKey: ['local-library-empty', user?.id],
    enabled: localReady && lastSyncedAt == null,
    queryFn: isLocalLibraryEmpty,
  });
  const [, force] = useState(0);

  // Re-render on each sync-log line (live phase) and once a second (elapsed).
  useEffect(() => {
    const unsub = subscribeSyncLog(() => force((n) => n + 1));
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, []);

  const neverSynced = lastSyncedAt == null;
  const eligible =
    !!user && tabRole === 'leader' && localReady && neverSynced && emptyLibrary === true;

  if (!eligible) return null;
  if (status !== 'syncing' && status !== 'error') return null;

  const elapsedS = syncingSince ? Math.floor((Date.now() - syncingSince) / 1000) : 0;

  if (status === 'error') {
    return (
      <LoadingOverlay
        title="Setting up your library"
        error={lastError ?? 'Sync ran into a problem.'}
        onRetry={() => void syncNow()}
        testId="first-sync-overlay"
      />
    );
  }

  return (
    <LoadingOverlay
      title="Setting up your library"
      subtitle="Pulling your recipes onto this device for the first time."
      step={`${phaseLabel()}${elapsedS > 3 ? `  (${elapsedS}s)` : ''}`}
      testId="first-sync-overlay"
    />
  );
}
