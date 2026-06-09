// Native (Capacitor) OAuth via the system browser.
//
// Google blocks OAuth inside embedded WebViews (`disallowed_useragent`), so on
// a native build we hand the provider's authorize URL to the system browser
// (Chrome Custom Tab on Android, SFSafariViewController on iOS) instead of
// navigating the WebView. Supabase redirects back to
// `cookyourbooks://auth/callback`, which auth/authDeepLink.ts catches to finish
// the session. On the web, sign-in keeps using the normal redirect.

import { supabase } from '../supabase.js';
import { OAUTH_NATIVE_REDIRECT } from './authDeepLink.js';

/** True when running inside the Capacitor native shell (iOS or Android). */
export function isCapacitorNative(): boolean {
  const cap = (globalThis as {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

/**
 * Begin an OAuth sign-in in the system browser. Resolves once the browser has
 * opened; the session is completed asynchronously when the OS delivers the
 * `cookyourbooks://auth/callback` deep link to initAuthDeepLink. Throws if
 * Supabase can't produce an authorize URL.
 *
 * Check isCapacitorNative() before calling; on the web use the inline
 * signInWithOAuth redirect instead.
 */
export async function signInWithOAuthNative(provider: 'google' | 'apple'): Promise<void> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: OAUTH_NATIVE_REDIRECT,
      // We open the URL in the system browser ourselves; don't let supabase-js
      // navigate the embedded WebView (which Google would reject).
      skipBrowserRedirect: true,
    },
  });
  if (error) throw error;
  if (!data?.url) throw new Error('OAuth provider did not return an authorization URL');
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url: data.url });
}
