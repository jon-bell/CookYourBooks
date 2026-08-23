import { useEffect, useState } from 'react';

import { flushSignals } from '../signals/capture.js';
import { signalsEnabled } from '../signals/prefs.js';
import { loadSignalsPref, saveSignalsPref } from '../signals/prefsApi.js';

/**
 * Opt-out for interaction-signal capture (what you searched for and which
 * result you opened; which suggested nutrition match or tag you accepted or
 * corrected). Lives on the Data & deletion tab beside the other "what leaves
 * this device" controls.
 *
 * The setting lives on the account (`profiles.share_interaction_signals`), so
 * it follows the user to every device, and the write RPCs enforce it
 * server-side — turning it off on a phone stops capture on the laptop too,
 * without waiting for that laptop to reload.
 *
 * Optimistic-with-rollback: the checkbox flips immediately (the toggle should
 * feel like a toggle) but reverts on a failed save, because a privacy control
 * that silently claims a state it didn't reach is worse than a visible error.
 */
export function ProductImprovementSection() {
  const [enabled, setEnabled] = useState(() => signalsEnabled());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-read the account setting on mount so this page shows the truth rather
  // than whatever the local cache last guessed.
  useEffect(() => {
    let cancelled = false;
    void loadSignalsPref().then((v) => {
      if (!cancelled) setEnabled(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onToggle(next: boolean) {
    // Anything already buffered was captured under the old setting; flush it
    // rather than dropping it silently, then stop queueing new events.
    if (!next) void flushSignals();
    const previous = enabled;
    setEnabled(next);
    setBusy(true);
    setError(null);
    try {
      await saveSignalsPref(next);
    } catch (e) {
      setEnabled(previous);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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
          checked={enabled}
          disabled={busy}
          onChange={(e) => void onToggle(e.target.checked)}
          data-testid="product-improvement-toggle"
          className="h-4 w-4 disabled:opacity-60"
        />
        <span>Share search and correction signals</span>
      </label>
      <p className="text-xs text-stone-500 dark:text-stone-400">
        This setting applies to your account, on every device you sign in to.
      </p>
      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    </section>
  );
}
