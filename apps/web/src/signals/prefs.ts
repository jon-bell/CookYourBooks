// Per-device opt-out for interaction-signal capture.
//
// localStorage rather than a `profiles` column, matching the other user-facing
// preference that doesn't need to reach the server (fallbackPrefs.ts). The
// tradeoff is real and worth naming: the choice does NOT follow the user to
// another device. It is stored inverted — absence means "capturing" — so the
// default is the same on a fresh install as it is after a reset, and a
// corrupted/unreadable value fails to the documented default rather than to
// silence.

const KEY = 'cookyourbooks.signals.optOut.v1';

/** True when the user has switched interaction-signal capture off here. */
export function isSignalsOptedOut(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    // Locked-down webviews throw on localStorage. Capture is best-effort and
    // never load-bearing, so treat an unreadable pref as the default (on).
    return false;
  }
}

export function setSignalsOptedOut(optedOut: boolean): void {
  try {
    if (optedOut) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Nothing useful to do — the toggle just won't persist on this device.
  }
}
