import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { previewInvite, type HouseholdInvitePreview, isTosNotAcceptedError } from '../household/api.js';
import { useAcceptHouseholdInvite } from '../household/queries.js';
import { AcceptTosGate } from '../household/AcceptTosGate.js';

/**
 * Invite acceptance page. URL: /household/join?token=<token>.
 *
 * Shows a preview (household name + inviter) and an accept button.
 * Errors are rendered verbatim from the server so cap / cooldown /
 * already-in-household / expired-invite explanations come through
 * without translation.
 */
export function HouseholdJoinPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const accept = useAcceptHouseholdInvite();
  const [preview, setPreview] = useState<HouseholdInvitePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tosOpen, setTosOpen] = useState(false);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const p = await previewInvite(token);
        if (!p) {
          setPreviewError('Invite not found.');
          return;
        }
        setPreview(p);
      } catch (err) {
        setPreviewError((err as Error).message);
      }
    })();
  }, [token]);

  if (!token) {
    return (
      <p className="text-stone-600 dark:text-stone-400">
        This URL is missing a token. Ask the household owner for a fresh invite link.
      </p>
    );
  }

  // AuthProvider needs a moment to call getSession on first paint. During
  // that window `user` is null but `loading` is true — render a quiet
  // placeholder so we don't briefly flash a sign-in CTA at users who are
  // in fact about to be recognised as signed in.
  if (authLoading) {
    return <p className="text-stone-500 dark:text-stone-400">Loading…</p>;
  }
  if (!user) {
    return (
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">Sign in to join</h1>
        <p className="text-stone-600 dark:text-stone-400">
          You need an account to accept a household invite.
        </p>
        <Link
          to={`/sign-in?next=${encodeURIComponent(`/household/join?token=${token}`)}`}
          className="inline-block rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900"
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (previewError) {
    return (
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">Invite unavailable</h1>
        <p className="text-red-700 dark:text-red-300">{previewError}</p>
      </section>
    );
  }

  if (!preview) {
    return <p className="text-stone-500 dark:text-stone-400">Loading invite…</p>;
  }

  const expired = new Date(preview.expires_at).getTime() < Date.now();
  const stale = preview.revoked || preview.used || expired;

  async function onAccept() {
    setError(null);
    try {
      await accept.mutateAsync(token);
      navigate('/household');
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
      <section className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">
            Join "{preview.household_name}"?
          </h1>
          <p className="mt-1 text-stone-600 dark:text-stone-400">
            {preview.invited_by_name
              ? `Invited by ${preview.invited_by_name}.`
              : 'You were invited to this household.'}
            {' '}
            Expires {new Date(preview.expires_at).toLocaleString()}.
          </p>
        </header>

        {stale && (
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            {preview.revoked && 'This invite has been revoked.'}
            {preview.used && 'This invite has already been used.'}
            {expired && !preview.revoked && !preview.used && 'This invite has expired.'}
            {' '}
            Ask the owner for a new link.
          </div>
        )}

        <div className="rounded-md border border-stone-300 dark:border-stone-600 bg-stone-50 dark:bg-stone-800 px-3 py-2 text-sm text-stone-800 dark:text-stone-200">
          <p>
            By joining, you'll be able to see recipe collections that members share with
            this household. The household has a hard cap of 6 members. If you leave or are
            removed, there's a 7-day cooldown before you can join or create another
            household.
          </p>
          <p className="mt-2 text-xs">
            Accepting this invite also accepts the current{' '}
            <Link to="/legal/terms" className="underline">Terms of Service</Link>
            {' and '}
            <Link to="/legal/aup" className="underline">Acceptable Use Policy</Link>.
          </p>
        </div>

        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={onAccept}
            disabled={stale || accept.isPending}
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 disabled:opacity-60"
          >
            {accept.isPending ? 'Joining…' : 'Join household'}
          </button>
          <Link
            to="/"
            className="rounded-md px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Cancel
          </Link>
        </div>
      </section>
      <AcceptTosGate
        open={tosOpen}
        onClose={() => setTosOpen(false)}
        onAccepted={() => {
          setTosOpen(false);
          void onAccept();
        }}
      />
    </>
  );
}
