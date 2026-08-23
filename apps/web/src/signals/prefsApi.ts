// The network half of the interaction-signal opt-out: reading and writing
// `profiles.share_interaction_signals`.
//
// Split from `prefs.ts` so the synchronous cache — which the enqueue gate and
// its unit tests depend on — doesn't transitively import the Supabase client.
// `supabase.ts` throws at module scope when VITE_SUPABASE_* is unset, which is
// exactly the state the unit-test job runs in.

import { supabase } from '../supabase.js';
import { applySignalsPref, signalsEnabled } from './prefs.js';

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
  applySignalsPref(enabled);
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
  applySignalsPref(enabled);
}
