import { useEffect, useState } from 'react';
import { snapshotDbInit } from '../local/db.js';
import { getBackfillProgress, subscribeBackfill } from '../local/backfill.js';
import { LoadingOverlay } from './LoadingOverlay.js';

// Cooking-flavored homage to the classic SimCity loading screen. Rotates while
// a slow schema migration / backfill runs so the wait reads as "we know this is
// slow and it's working", not "frozen".
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

// Only the steps that can actually take a while are worth a popup. A fresh /
// fast boot blows through these in well under the show threshold.
const SLOW_INIT_STEPS = new Set([
  'applying schema',
  'post-schema migrations',
  'promoting tables to CRR',
  'CRR trigger heal',
]);
const SHOW_AFTER_MS = 400;

function stepLabel(rawStep: string): string {
  if (rawStep === 'applying schema' || rawStep === 'post-schema migrations') {
    return 'Updating your recipe box…';
  }
  if (rawStep === 'promoting tables to CRR' || rawStep === 'CRR trigger heal') {
    return 'Reorganizing the pantry…';
  }
  return 'Tidying up…';
}

export function SchemaUpgradeOverlay() {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 400);
    const unsub = subscribeBackfill(() => force((n) => n + 1));
    return () => {
      clearInterval(t);
      unsub();
    };
  }, []);

  // A running backfill wins (it has a real progress bar and runs after init).
  const backfill = getBackfillProgress().find((b) => b.status === 'running');
  if (backfill) {
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

  const init = snapshotDbInit();
  const slowInit =
    init.startedAt != null &&
    init.finishedAt == null &&
    init.error == null &&
    Date.now() - init.startedAt > SHOW_AFTER_MS &&
    SLOW_INIT_STEPS.has(init.step);
  if (slowInit) {
    return (
      <LoadingOverlay
        title="Upgrading your library"
        subtitle="This only happens once — hang tight."
        step={stepLabel(init.step)}
        lines={FUNNY_LINES}
        testId="schema-upgrade-overlay"
      />
    );
  }

  return null;
}
