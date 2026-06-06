import { useState } from 'react';
import { useSetLibrarySharing } from './queries.js';
import { isTosNotAcceptedError } from './api.js';
import { AcceptTosGate } from './AcceptTosGate.js';

const DEFAULT_ATTESTATION =
  'I own the content in my library or have explicit permission to share it with my household.';

/**
 * Household-page control for whether the caller shares their *whole*
 * library with the household. Sharing is on by default for members;
 * this lets a member opt out (and back in). Opting in requires the
 * one-time rights attestation, which the server records in audit_log —
 * the same legal posture the old per-collection share dialog had, but
 * captured once for the entire library instead of per collection.
 */
export function LibrarySharingSection({
  householdId,
  householdName,
  libraryShared,
}: {
  householdId: string;
  householdName: string;
  libraryShared: boolean;
}) {
  const setSharing = useSetLibrarySharing();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [attestation, setAttestation] = useState(DEFAULT_ATTESTATION);
  const [checked, setChecked] = useState(false);
  const [tosOpen, setTosOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enable() {
    setError(null);
    try {
      await setSharing.mutateAsync({ householdId, enabled: true, attestation });
      setDialogOpen(false);
      setChecked(false);
    } catch (err) {
      if (isTosNotAcceptedError(err)) {
        setTosOpen(true);
        return;
      }
      setError((err as Error).message);
    }
  }

  async function disable() {
    setError(null);
    if (!confirm('Stop sharing your library with this household?')) return;
    try {
      await setSharing.mutateAsync({ householdId, enabled: false });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div data-testid="library-sharing-section">
      <h2 className="text-lg font-semibold">Library sharing</h2>
      <div className="mt-2 rounded-md border border-stone-200 dark:border-stone-700 px-3 py-3">
        {libraryShared ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-stone-700 dark:text-stone-300">
              <span className="rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700 px-2 py-0.5 text-xs text-emerald-900 dark:text-emerald-200">
                Sharing on
              </span>{' '}
              Everyone in <strong>{householdName}</strong> can read your whole library. They
              can't edit, fork, or re-share it.
            </p>
            <button
              onClick={disable}
              disabled={setSharing.isPending}
              data-testid="library-sharing-disable"
              className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60"
            >
              Stop sharing my library
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-stone-700 dark:text-stone-300">
              <span className="rounded-md bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-600 px-2 py-0.5 text-xs">
                Sharing off
              </span>{' '}
              Your library is private. Turn sharing on so the rest of {householdName} can read
              your collections.
            </p>
            <button
              onClick={() => setDialogOpen(true)}
              disabled={setSharing.isPending}
              data-testid="library-sharing-enable"
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 disabled:opacity-60"
            >
              Share my library
            </button>
          </div>
        )}
        {error && <p className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
      </div>

      {dialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Share library with household"
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
          onClick={() => setDialogOpen(false)}
        >
          <div
            className="w-full max-w-lg space-y-3 rounded-lg bg-white dark:bg-stone-900 p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold">Share your library with {householdName}?</h3>
            <p className="text-sm text-stone-700 dark:text-stone-300">
              Every collection you own — and any you add later — becomes readable by the other
              members of your household. They can't edit, fork, or re-share it.
            </p>
            <div className="rounded-md border border-stone-300 dark:border-stone-600 bg-stone-50 dark:bg-stone-800 px-3 py-2 text-sm text-stone-800 dark:text-stone-200">
              <p className="font-medium">Attestation</p>
              <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
                Logged into the audit trail with your account ID and a timestamp. The full audit
                record is available to admins for DMCA response.
              </p>
              <textarea
                value={attestation}
                onChange={(e) => setAttestation(e.target.value)}
                rows={2}
                maxLength={500}
                className="mt-2 w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 text-sm"
                data-testid="library-attestation-text"
              />
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                  data-testid="library-attestation-checkbox"
                />
                <span>I confirm the statement above is true.</span>
              </label>
            </div>
            {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setDialogOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                Cancel
              </button>
              <button
                onClick={enable}
                disabled={!checked || !attestation.trim() || setSharing.isPending}
                data-testid="library-sharing-confirm"
                className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 disabled:opacity-60"
              >
                {setSharing.isPending ? 'Sharing…' : 'Share my library'}
              </button>
            </div>
          </div>
        </div>
      )}

      <AcceptTosGate
        open={tosOpen}
        onClose={() => setTosOpen(false)}
        onAccepted={() => {
          setTosOpen(false);
          void enable();
        }}
      />
    </div>
  );
}
