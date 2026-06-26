import { useEffect, useState } from 'react';

import { getBackfillProgress, subscribeBackfill } from '../local/backfill.js';
import { COOKING_FLAVOR_LINES } from './loadingLines.js';
import { LoadingOverlay } from './LoadingOverlay.js';

/**
 * Shown only while a one-time local backfill is actively running. We
 * deliberately do NOT cover the generic DB-init phase: a cold WASM boot can
 * exceed any small threshold yet isn't a real "upgrade", and a blocking modal
 * there would cover the sign-in form / first paint. The backfill, by contrast,
 * runs only post-login and only when there's existing data to migrate (an
 * empty DB finishes instantly without ever entering the running state), so it's
 * a safe, meaningful "we're upgrading your library" moment with real progress.
 */
export function SchemaUpgradeOverlay() {
  const [, force] = useState(0);
  useEffect(() => {
    const unsub = subscribeBackfill(() => force((n) => n + 1));
    // Light poll so the progress bar advances between backfill chunk events.
    const t = setInterval(() => force((n) => n + 1), 500);
    return () => {
      clearInterval(t);
      unsub();
    };
  }, []);

  const backfill = getBackfillProgress().find((b) => b.status === 'running');
  if (!backfill) return null;

  return (
    <LoadingOverlay
      title="Upgrading your library"
      subtitle="This only happens once — hang tight."
      step="Filling in the details…"
      progress={backfill.total ? { processed: backfill.processed, total: backfill.total } : null}
      lines={[...COOKING_FLAVOR_LINES]}
      testId="schema-upgrade-overlay"
    />
  );
}
