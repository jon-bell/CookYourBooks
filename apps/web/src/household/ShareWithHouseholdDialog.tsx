import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMyHousehold, useShareCollectionWithHousehold } from './queries.js';
import { isTosNotAcceptedError } from './api.js';
import { AcceptTosGate } from './AcceptTosGate.js';

const DEFAULT_ATTESTATION =
  'I own this content or have explicit permission to share it with my household.';

/**
 * Owner-side dialog for sharing a collection with the user's household.
 *
 * Mirrors `MakePublicDialog` for structural consistency but with a
 * different posture: household sharing has a much narrower audience
 * (up to 6 named people inside one household) so the legal language
 * is dialed down — but an attestation is still required, and is
 * logged into `audit_log` along with the timestamp.
 */
export function ShareWithHouseholdDialog({
  open,
  collectionTitle,
  collectionId,
  onClose,
  onShared,
}: {
  open: boolean;
  collectionTitle: string;
  collectionId: string;
  onClose: () => void;
  onShared: () => void;
}) {
  const my = useMyHousehold();
  const share = useShareCollectionWithHousehold();
  const [attestation, setAttestation] = useState(DEFAULT_ATTESTATION);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tosOpen, setTosOpen] = useState(false);

  if (!open) return null;

  async function onConfirm() {
    setError(null);
    if (!my.data) {
      setError('You are not in a household.');
      return;
    }
    try {
      await share.mutateAsync({
        collectionId,
        householdId: my.data.household.id,
        attestation,
      });
      onShared();
    } catch (err) {
      if (isTosNotAcceptedError(err)) {
        setTosOpen(true);
        return;
      }
      setError((err as Error).message);
    }
  }

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share with household"
        className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
        onClick={onClose}
      >
        <div
          className="w-full max-w-lg space-y-3 rounded-lg bg-white dark:bg-stone-900 p-5 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="text-lg font-semibold">
            Share "{collectionTitle}" with your household?
          </h2>
          {my.data ? (
            <p className="text-sm text-stone-700 dark:text-stone-300">
              Members of <strong>{my.data.household.name}</strong> ({my.data.members.length}{' '}
              {my.data.members.length === 1 ? 'person' : 'people'}) will be able to read this
              collection's recipes in their own library. They can't edit it, fork it, or
              re-share it.
            </p>
          ) : (
            <p className="text-sm text-red-700 dark:text-red-300">
              You're not in a household. <Link to="/household" className="underline">Create or join one</Link> first.
            </p>
          )}

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
              data-testid="share-attestation-text"
            />
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                data-testid="share-attestation-checkbox"
              />
              <span>I confirm the statement above is true.</span>
            </label>
          </div>

          {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800">
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={!my.data || !checked || !attestation.trim() || share.isPending}
              data-testid="share-confirm"
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 disabled:opacity-60"
            >
              {share.isPending ? 'Sharing…' : 'Share with household'}
            </button>
          </div>
        </div>
      </div>
      <AcceptTosGate
        open={tosOpen}
        onClose={() => setTosOpen(false)}
        onAccepted={() => {
          setTosOpen(false);
          void onConfirm();
        }}
      />
    </>
  );
}
