import { useEffect, useState } from 'react';
import { getBackfillProgress, subscribeBackfill } from '../local/backfill.js';
import { LoadingOverlay } from './LoadingOverlay.js';

// Cooking-flavored homage to the classic SimCity loading screen. Rotates while
// the one-time data backfill runs so the wait reads as "we know this is slow
// and it's working", not "frozen".
const FUNNY_LINES = [
  'Reticulating roux…',
  'Proofing the dough…',
  'Caramelizing onions (slowly, as one must)…',
  'Deglazing the database…',
  'Whisking the watermarks…',
  'Mincing shallots…',
  'Folding in the cheese…',
  'Blanching the foreign keys…',
  'Resting the brisket…',
  'Decanting the indexes…',
  'Tempering the chocolate…',
  'Seasoning to taste…',
  'Aligning the mise en place…',
  'Reducing the stock (by half)…',
  'Calibrating the oven mitts…',
  'Emulsifying the vinaigrette…',
  'Sharpening the knives…',
  'Consulting grandma’s notes…',
  'Preheating to 425°F…',
];

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
      lines={FUNNY_LINES}
      testId="schema-upgrade-overlay"
    />
  );
}
