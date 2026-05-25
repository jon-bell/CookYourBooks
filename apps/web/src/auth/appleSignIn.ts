// Sign in with Apple — cross-platform entry point. App Store guideline
// 4.8 requires this to be offered whenever we also offer Google OAuth
// (which we do on SignInPage / SignUpPage).
//
// On Capacitor iOS: uses @capacitor-community/apple-sign-in to invoke the
// native ASAuthorizationController flow (system-rendered sheet, no
// browser switch), then hands the resulting identity token to Supabase
// via signInWithIdToken.
//
// On web (incl. Android Capacitor): falls back to Supabase's
// signInWithOAuth which redirects to Apple's web auth flow and back to
// our origin.

import { supabase } from '../supabase.js';

function isCapacitorIOS(): boolean {
  const cap = (globalThis as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  return !!cap?.isNativePlatform?.() && cap?.getPlatform?.() === 'ios';
}

/**
 * Drives the Apple sign-in flow appropriate for the current runtime.
 * Resolves when the user is authenticated (or the OAuth redirect has
 * been kicked off, in the web case). Rejects with the underlying error
 * on actual failure; user-cancellation is swallowed and resolves to
 * `{ cancelled: true }`.
 */
export async function signInWithApple(): Promise<
  { cancelled: true } | { cancelled?: false }
> {
  if (isCapacitorIOS()) return signInWithAppleNative();
  return signInWithAppleWeb();
}

async function signInWithAppleNative(): Promise<
  { cancelled: true } | { cancelled?: false }
> {
  const { SignInWithApple } = await import('@capacitor-community/apple-sign-in');
  try {
    const result = await SignInWithApple.authorize({
      clientId: 'app.cookyourbooks',
      // Redirect URI is required by the plugin's web fallback but ignored
      // by the iOS-native path. Point it at our Supabase callback so it's
      // a valid value if the user is somehow on the web shim.
      redirectURI: 'https://xdyhhycfolcpqdawfkcj.supabase.co/auth/v1/callback',
      scopes: 'email name',
    });
    const idToken = result.response.identityToken;
    if (!idToken) {
      throw new Error('Apple sign-in did not return an identity token');
    }
    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: idToken,
    });
    if (error) throw error;
    return {};
  } catch (err) {
    // The plugin throws on cancellation with a code-1001 style error.
    if (isCancellation(err)) return { cancelled: true };
    throw err;
  }
}

async function signInWithAppleWeb(): Promise<
  { cancelled: true } | { cancelled?: false }
> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'apple',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
  return {};
}

function isCancellation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as { message?: string }).message ?? '');
  const code = (err as { code?: string | number }).code;
  return /cancel|denied|user.?cancel|1001/i.test(msg) || code === '1001' || code === 1001;
}
