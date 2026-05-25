// "Continue with Apple" / "Sign in with Apple" button — Apple HIG-styled
// (solid black, white SF-style Apple logo). Drives the cross-platform
// signInWithApple() flow.

import { useState } from 'react';
import { signInWithApple } from './appleSignIn.js';

interface Props {
  /** Label override. Default "Continue with Apple". */
  label?: string;
  /** Called after a non-cancellation error — for surfacing to the user. */
  onError?: (msg: string) => void;
}

export function AppleButton({ label = 'Continue with Apple', onError }: Props) {
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      await signInWithApple();
      // Auth state change is broadcast via Supabase's onAuthStateChange
      // listener in AuthProvider; the navigation happens in the page-level
      // handlers that observe `user` flipping non-null.
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center justify-center gap-2 rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
    >
      <AppleLogo className="h-4 w-4" />
      <span>{busy ? 'Signing in…' : label}</span>
    </button>
  );
}

function AppleLogo({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 17 17"
      className={className}
      fill="currentColor"
    >
      <path d="M13.62 9.12c-.02-2.05 1.67-3.04 1.75-3.09-.95-1.4-2.44-1.59-2.97-1.61-1.26-.13-2.46.74-3.1.74-.65 0-1.63-.72-2.68-.7-1.38.02-2.66.8-3.37 2.04-1.44 2.49-.37 6.18 1.04 8.21.69.99 1.5 2.1 2.55 2.06 1.03-.04 1.42-.66 2.66-.66s1.59.66 2.68.64c1.11-.02 1.81-1 2.49-2 .78-1.15 1.1-2.27 1.12-2.33-.02-.01-2.15-.83-2.17-3.3zM11.55 2.95c.57-.69.95-1.65.85-2.6-.82.03-1.81.55-2.4 1.23-.53.61-1 1.59-.87 2.52.91.07 1.85-.46 2.42-1.15z"/>
    </svg>
  );
}
