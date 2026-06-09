// Native OAuth deep-link completion.
//
// Google (and other providers) reject OAuth performed inside an embedded
// WebView with `disallowed_useragent`. On a Capacitor build we therefore open
// the provider's authorize URL in the system browser (see auth/oauthNative.ts)
// and Supabase redirects back to `cookyourbooks://auth/callback?code=…`. The OS
// delivers that deep link to the `@capacitor/app` `appUrlOpen` event; this
// module catches it, exchanges the PKCE code for a session, and dismisses the
// in-app browser. On the web it's an inert no-op (the normal redirect flow runs
// instead, and supabase-js detectSessionInUrl finishes it).

import { supabase } from '../supabase.js';

const AUTH_CALLBACK_HOST = 'auth';
const AUTH_CALLBACK_PATH = '/callback';

/**
 * Deep link the system browser returns to after OAuth. Must match the custom
 * scheme declared in the iOS Info.plist / Android manifest AND be listed in
 * Supabase Auth → URL Configuration → Redirect URLs.
 */
export const OAUTH_NATIVE_REDIRECT = 'cookyourbooks://auth/callback';

interface AppPlugin {
  addListener?: (
    event: 'appUrlOpen',
    cb: (data: unknown) => void,
  ) => { remove?: () => void } | Promise<{ remove?: () => void }>;
}
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { App?: AppPlugin };
}
function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/**
 * True if `raw` is the OAuth return deep link (`cookyourbooks://auth/callback…`)
 * rather than a shared recipe link. `import/shareIntent.ts` uses this to ignore
 * auth returns so it doesn't try to import them as a recipe URL.
 */
export function isAuthCallbackUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'cookyourbooks:' &&
      u.host === AUTH_CALLBACK_HOST &&
      u.pathname.replace(/\/+$/, '') === AUTH_CALLBACK_PATH
    );
  } catch {
    return false;
  }
}

/**
 * Listen for the OAuth return deep link and complete the Supabase session.
 * `onAuthed` runs after a session is established so the caller can navigate off
 * the sign-in page (AuthProvider's onAuthStateChange propagates the rest).
 * Returns a cleanup fn. No-op on the web / when the App plugin is absent.
 */
export function initAuthDeepLink(onAuthed: () => void): () => void {
  if (!capacitor()?.isNativePlatform?.()) return () => {};
  const App = capacitor()?.Plugins?.App;
  if (!App?.addListener) return () => {};

  const handle = App.addListener('appUrlOpen', (data: unknown) => {
    const url =
      data && typeof data === 'object' ? (data as { url?: unknown }).url : undefined;
    if (!isAuthCallbackUrl(url)) return;
    void completeOAuth(url as string).then((ok) => {
      if (ok) onAuthed();
    });
  });

  return () => {
    void Promise.resolve(handle)
      .then((h) => h?.remove?.())
      .catch(() => {});
  };
}

/**
 * Exchange the PKCE `code` from the callback URL for a session. Always closes
 * the system browser afterwards. Resolves true on success.
 */
async function completeOAuth(callbackUrl: string): Promise<boolean> {
  try {
    const u = new URL(callbackUrl);
    const code = u.searchParams.get('code');
    if (!code) {
      const reason = u.searchParams.get('error_description') ?? u.searchParams.get('error');
      // eslint-disable-next-line no-console
      if (reason) console.error('[auth-deeplink] OAuth returned without a code:', reason);
      return false;
    }
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth-deeplink] failed to complete OAuth', err);
    return false;
  } finally {
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.close();
    } catch {
      /* browser already closed / not available (e.g. web) */
    }
  }
}
