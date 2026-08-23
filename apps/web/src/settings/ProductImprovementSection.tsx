import { useState } from 'react';

import { flushSignals } from '../signals/capture.js';
import { isSignalsOptedOut, setSignalsOptedOut } from '../signals/prefs.js';

/**
 * Opt-out for interaction-signal capture (what you searched for and which
 * result you opened; which suggested nutrition match or tag you accepted or
 * corrected). Lives on the Data & deletion tab beside the other "what leaves
 * this device" controls.
 *
 * The pref is per-device (localStorage — see signals/prefs.ts), which the copy
 * says out loud rather than implying an account-wide guarantee we don't make.
 * Switching capture off flushes whatever is already buffered: those events were
 * captured under the previous setting and dropping them silently would be a
 * worse answer than sending them, but nothing new is queued afterwards.
 */
export function ProductImprovementSection() {
  const [optedOut, setOptedOut] = useState(() => isSignalsOptedOut());

  function onToggle(next: boolean) {
    if (!next) void flushSignals();
    setSignalsOptedOut(!next);
    setOptedOut(!next);
  }

  return (
    <section data-testid="product-improvement" className="mt-6 space-y-2">
      <h2 className="text-lg font-semibold">Help improve search and matching</h2>
      <p className="text-sm text-stone-700 dark:text-stone-300">
        When this is on, CookYourBooks records which searches you run and which result you open, and
        which suggested nutrition match or tag you accept or correct. We use it to improve ranking —
        nothing is shared with your household, sold, or sent to a third party, and it's deleted
        after 180 days.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!optedOut}
          onChange={(e) => onToggle(e.target.checked)}
          data-testid="product-improvement-toggle"
          className="h-4 w-4"
        />
        <span>Share search and correction signals</span>
      </label>
      <p className="text-xs text-stone-500 dark:text-stone-400">
        This setting applies to this device only.
      </p>
    </section>
  );
}
