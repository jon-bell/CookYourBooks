// The interaction-signal opt-out, stored on the account
// (`profiles.share_interaction_signals`) so it follows the user across
// devices.
//
// Three layers, because the enqueue gate in capture.ts has to answer
// "recording?" SYNCHRONOUSLY and cannot await a round trip on every keystroke:
//
//   1. `profiles.share_interaction_signals` — the source of truth, and the
//      only one that binds: `record_search_events` / `record_suggestion_events`
//      read it server-side and drop the batch when it's false. So a stale
//      client can waste a request, but it cannot record against the user's
//      wishes.
//   2. A module-level cache — what the synchronous gate actually reads.
//   3. A localStorage mirror — seeds the cache before the profile fetch
//      resolves, so a page load doesn't spend its first seconds capturing
//      under the wrong assumption. It is a cache, not the setting; clearing it
//      loses nothing but a round trip.

import { supabase } from '../supabase.js';

const MIRROR_KEY = 'cookyourbooks.signals.enabled.v1';

/** Unknown until the mirror is read or the profile resolves. */
let cached: boolean | undefined;

function readMirror(): boolean | undefined {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return undefined;
  } catch {
    // Locked-down webviews throw on localStorage. Fall through to the default.
    return undefined;
  }
}

function writeMirror(enabled: boolean): void {
  try {
    localStorage.setItem(MIRROR_KEY, enabled ? '1' : '0');
  } catch {
    // Nothing to do — we just pay a round trip on the next page load.
  }
}

/**
 * Synchronous answer for the enqueue gate. Defaults to ON (matching the
 * column default) when we've never heard otherwise: the server enforces the
 * real setting, so the worst case for a wrong guess here is a wasted request,
 * not a recorded event.
 */
export function signalsEnabled(): boolean {
  cached ??= readMirror();
  return cached ?? true;
}

/**
 * Fetch the account setting and update the cache + mirror. Called once when a
 * session appears (SignalsPrefLoader in App.tsx). Best-effort: on failure the
 * cache keeps whatever the mirror said, and the server still enforces.
 */
export async function loadSignalsPref(): Promise<boolean> {
  const { data, error } = await supabase
    .from('profiles')
    .select('share_interaction_signals')
    .maybeSingle();
  if (error || !data) return signalsEnabled();
  // The column is created by 20260715000000 but isn't in the checked-in
  // generated Supabase types yet (regenerated out of band, like every new
  // column) — same shim the other post-regen call sites use.
  const enabled = (data as { share_interaction_signals?: boolean }).share_interaction_signals;
  if (typeof enabled !== 'boolean') return signalsEnabled();
  cached = enabled;
  writeMirror(enabled);
  return enabled;
}

/**
 * Persist the setting to the account. The cache + mirror are only updated
 * after the write lands, so a failed save leaves the UI and the gate agreeing
 * with the server rather than drifting from it.
 */
export async function saveSignalsPref(enabled: boolean): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in to change this setting.');
  const { error } = await supabase
    .from('profiles')
    .update({ share_interaction_signals: enabled } as never)
    .eq('id', user.id);
  if (error) throw error;
  cached = enabled;
  writeMirror(enabled);
}

/** Test seam: set the cache directly, bypassing network and localStorage. */
export function primeSignalsPref(enabled: boolean | undefined): void {
  cached = enabled;
}
