import { useState } from 'react';
import { Link } from 'react-router-dom';

import { CURRENT_TOS_VERSION } from './api.js';
import { useAcceptTos } from './queries.js';

/**
 * Modal that intercepts an action gated on current ToS acceptance.
 *
 * The server raises P0001 with `TOS_NOT_ACCEPTED:` when share/publish
 * / invite flows are attempted by a user whose `profiles.tos_version`
 * is stale. The caller catches that, opens this dialog, and on success
 * retries the original action via the `onAccepted` callback.
 *
 * The legal text itself lives in /legal/terms — this gate is just the
 * gate, not the document.
 */
export function AcceptTosGate({
  open,
  onClose,
  onAccepted,
}: {
  open: boolean;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const accept = useAcceptTos();
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;

  async function onConfirm() {
    setError(null);
    try {
      await accept.mutateAsync(CURRENT_TOS_VERSION);
      onAccepted();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Accept Terms of Service"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg space-y-3 rounded-lg bg-white dark:bg-stone-900 p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Accept the Terms of Service to continue</h2>
        <p className="text-sm text-stone-700 dark:text-stone-300">
          Sharing or publishing content requires you to confirm the current Terms of Service and
          Acceptable Use Policy. Reading content does not.
        </p>
        <ul className="ml-5 list-disc text-sm text-stone-700 dark:text-stone-300 space-y-1">
          <li>You can only share content you own or have rights to redistribute.</li>
          <li>Confirmed copyright violations result in a permanent account ban.</li>
          <li>Rights holders can take down content via the DMCA process.</li>
        </ul>
        <p className="text-sm">
          Full text:{' '}
          <Link to="/legal/terms" className="underline" target="_blank">
            Terms
          </Link>{' '}
          ·{' '}
          <Link to="/legal/aup" className="underline" target="_blank">
            Acceptable Use
          </Link>{' '}
          ·{' '}
          <Link to="/legal/dmca" className="underline" target="_blank">
            DMCA
          </Link>
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            data-testid="tos-checkbox"
          />
          <span>I have read and agree to version {CURRENT_TOS_VERSION} of the Terms.</span>
        </label>
        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!checked || accept.isPending}
            data-testid="tos-accept"
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 disabled:opacity-60"
          >
            {accept.isPending ? 'Saving…' : 'Accept and continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
