import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider.js';
import { supabase } from '../supabase.js';

/**
 * Right-to-erasure UX.
 *
 * Calls the security-definer `delete_my_account` RPC. The RPC nukes the
 * caller from `auth.users` which cascades to `public.profiles` which
 * cascades to every user-owned table. The audit log survives the
 * cascade (audit_log.actor_id is `on delete set null`) per the Privacy
 * Policy carve-out for takedown defense.
 *
 * The "type DELETE to confirm" gate is the only friction beyond a
 * normal click-to-confirm — deletion is irrevocable, and the legal
 * spec promises an in-app erasure path, not a one-click landmine.
 */
export function DangerZoneSection() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setError(null);
    setBusy(true);
    try {
      const { error: rpcError } = await supabase.rpc('delete_my_account');
      if (rpcError) {
        // Likely cause: owner of a household with other active members.
        // The RPC raises with the actionable message; surface it.
        throw new Error(rpcError.message);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      return;
    }
    // RPC succeeded — the auth.users row is gone. The session token
    // the browser holds is now invalid; we MUST clear local state and
    // get the user out of the authenticated UI no matter what
    // signOut() does. Catch + force-navigate so a transient signOut
    // failure can't leave the user staring at a stale session.
    try {
      await signOut();
    } catch {
      // The session is already invalid server-side; localStorage is
      // the only thing left and the navigate-with-replace below will
      // unmount everything that reads from it.
    }
    navigate('/', { replace: true });
  }

  return (
    <section
      data-testid="danger-zone"
      className="mt-8 rounded-md border border-red-300 dark:border-red-800 bg-red-50/40 dark:bg-red-950/20 p-4"
    >
      <h2 className="text-lg font-semibold text-red-900 dark:text-red-200">Delete account</h2>
      <p className="mt-1 text-sm text-stone-700 dark:text-stone-300">
        Permanently delete your account, your recipe library, your collections, your import history,
        and any household memberships. This cannot be undone.
      </p>
      <p className="mt-2 text-xs text-stone-600 dark:text-stone-400">
        Your audit-log entries (sharing, attestation, ToS acceptance) are{' '}
        <strong>retained indefinitely</strong> with the actor link removed, per the
        legitimate-interest carve-out in our{' '}
        <a href="/legal/privacy" className="underline">
          Privacy Policy
        </a>{' '}
        for takedown defense and abuse investigation. If you own a household with other active
        members, transfer ownership first.
      </p>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setTyped('');
          setError(null);
        }}
        data-testid="open-delete-account"
        className="mt-3 rounded-md border border-red-400 dark:border-red-700 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40"
      >
        Delete my account…
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm account deletion"
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="w-full max-w-md space-y-3 rounded-lg bg-white dark:bg-stone-900 p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold">Delete this account?</h3>
            <p className="text-sm text-stone-700 dark:text-stone-300">
              Type <strong>DELETE</strong> below to confirm. This action is
              <strong> irreversible.</strong>
            </p>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type DELETE"
              data-testid="delete-confirm-input"
              className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm"
              autoFocus
            />
            {error && (
              <div
                data-testid="delete-error"
                className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300"
              >
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={typed !== 'DELETE' || busy}
                data-testid="confirm-delete-account"
                className="rounded-md bg-red-700 dark:bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 dark:hover:bg-red-500 disabled:opacity-60"
              >
                {busy ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
