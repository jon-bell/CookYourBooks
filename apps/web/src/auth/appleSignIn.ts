// Native iOS Sign-in-with-Apple path. The web (and Capacitor-Android)
// flow uses `supabase.auth.signInWithOAuth({ provider: 'apple' })`
// inline in the sign-in/sign-up pages — that redirect-based flow works
// in any browser and on Android. On iOS that same call opens an
// external Safari, which is jarring and (per App Store reviewers) less
// preferred than the system-rendered ASAuthorizationController sheet.
// So on iOS we intercept and use @capacitor-community/apple-sign-in
// instead, then hand the resulting identity token to Supabase's
// signInWithIdToken.

import { supabase } from '../supabase.js';

/** True if running inside the Capacitor iOS shell. */
export function isCapacitorIOS(): boolean {
  const cap = (globalThis as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  return !!cap?.isNativePlatform?.() && cap?.getPlatform?.() === 'ios';
}

/**
 * Drives the native iOS Sign-in-with-Apple flow. Resolves with
 * `{ cancelled: true }` when the user dismisses the sheet, or
 * `{ cancelled: false }` once Supabase has accepted the identity token
 * and the auth state listener has been notified. Rejects with the
 * underlying error otherwise.
 *
 * Caller is responsible for checking `isCapacitorIOS()` first; calling
 * this on web or Android throws when the plugin isn't bundled.
 */
export async function signInWithAppleNative(): Promise<
  { cancelled: true } | { cancelled: false }
> {
  const { SignInWithApple } = await import('@capacitor-community/apple-sign-in');
  try {
    const result = await SignInWithApple.authorize({
      clientId: 'app.cookyourbooks',
      // The plugin requires a redirect URI for its web fallback but ignores
      // it on the iOS-native path. Point it at the Supabase callback so
      // it's a valid value either way.
      redirectURI: 'https://xdyhhycfolcpqdawfkcj.supabase.co/auth/v1/callback',
      scopes: 'email name',
    });
    const idToken = result.response.identityToken;
    if (!idToken) throw new Error('Apple sign-in did not return an identity token');
    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: idToken,
    });
    if (error) throw error;
    return { cancelled: false };
  } catch (err) {
    if (isCancellation(err)) return { cancelled: true };
    throw err;
  }
}

function isCancellation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as { message?: string }).message ?? '');
  const code = (err as { code?: string | number }).code;
  return /cancel|denied|user.?cancel|1001/i.test(msg) || code === '1001' || code === 1001;
}
