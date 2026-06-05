import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import {
  useCreateHousehold,
  useDeleteHousehold,
  useHouseholdInvites,
  useInviteToHousehold,
  useLeaveHousehold,
  useMyCooldown,
  useMyHousehold,
  useRemoveHouseholdMember,
  useRenameHousehold,
  useRevokeHouseholdInvite,
  useTransferHouseholdOwnership,
} from '../household/queries.js';
import { AcceptTosGate } from '../household/AcceptTosGate.js';
import { AuditLogSection } from '../household/AuditLogSection.js';
import { isTosNotAcceptedError } from '../household/api.js';

/**
 * Household membership + settings page.
 *
 * Three states this page can be in:
 *   1. Not in a household — show "Create household" form + cooldown banner.
 *   2. Member — show member list, leave button.
 *   3. Owner — show member list with remove/transfer controls + invite UI.
 *
 * The page is the only place the user can manage household state outside
 * of an accept-invite flow.
 */
export function HouseholdPage() {
  const { user } = useAuth();
  const my = useMyHousehold();
  const cooldown = useMyCooldown();
  const [error, setError] = useState<string | null>(null);
  const [tosGateOpen, setTosGateOpen] = useState(false);

  if (!user) {
    return (
      <p className="text-stone-600 dark:text-stone-400">
        <Link to="/sign-in" className="underline">Sign in</Link> to manage your household.
      </p>
    );
  }
  if (my.isLoading) return <p className="text-stone-500 dark:text-stone-400">Loading…</p>;
  if (my.error) return <p className="text-red-700 dark:text-red-300">{(my.error as Error).message}</p>;

  const data = my.data;
  if (!data) {
    return (
      <>
        <NoHouseholdView
          cooldownUntil={cooldown.data ? new Date(cooldown.data.eligible_at) : null}
          setError={setError}
          openTosGate={() => setTosGateOpen(true)}
          error={error}
        />
        <AcceptTosGate
          open={tosGateOpen}
          onClose={() => setTosGateOpen(false)}
          onAccepted={() => {
            setTosGateOpen(false);
            setError(null);
          }}
        />
      </>
    );
  }

  return (
    <>
      <HouseholdView
        household={data.household}
        members={data.members}
        role={data.role}
        userId={user.id}
        setError={setError}
        error={error}
      />
      <AcceptTosGate
        open={tosGateOpen}
        onClose={() => setTosGateOpen(false)}
        onAccepted={() => {
          setTosGateOpen(false);
          setError(null);
        }}
      />
    </>
  );
}

// ---------- No-household view ----------

function NoHouseholdView({
  cooldownUntil,
  setError,
  openTosGate,
  error,
}: {
  cooldownUntil: Date | null;
  setError: (e: string | null) => void;
  openTosGate: () => void;
  error: string | null;
}) {
  const [name, setName] = useState('');
  const create = useCreateHousehold();

  const cooldownActive = cooldownUntil && cooldownUntil.getTime() > Date.now();

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync(name.trim());
    } catch (err) {
      if (isTosNotAcceptedError(err)) {
        openTosGate();
        return;
      }
      setError((err as Error).message);
    }
  }

  return (
    <section aria-labelledby="household-empty-title" className="space-y-4">
      <header>
        <h1 id="household-empty-title" className="text-2xl font-semibold">Household sharing</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          Create a household to share recipe collections with up to 6 family members. Members see
          each other's shared collections in their own library — content stays inside the household.
        </p>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
          <Link to="/legal/aup" className="underline">Acceptable Use Policy</Link>
          {' · '}
          <Link to="/legal/terms" className="underline">Terms of Service</Link>
        </p>
      </header>

      {cooldownActive && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          You recently left or were removed from a household. You can create or join one again
          after <strong>{cooldownUntil!.toLocaleString()}</strong>.
        </div>
      )}

      <form onSubmit={onCreate} className="space-y-3">
        <label className="block">
          <span className="block text-sm font-medium">Household name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="The Bell Family"
            maxLength={80}
            className="mt-1 w-full max-w-md rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={cooldownActive || !name.trim() || create.isPending}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
        >
          {create.isPending ? 'Creating…' : 'Create household'}
        </button>
        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      </form>
    </section>
  );
}

// ---------- Member-of-household view ----------

import type { Household, HouseholdMemberWithProfile, HouseholdRole } from '../household/api.js';

function HouseholdView({
  household,
  members,
  role,
  userId,
  setError,
  error,
}: {
  household: Household;
  members: HouseholdMemberWithProfile[];
  role: HouseholdRole;
  userId: string;
  setError: (e: string | null) => void;
  error: string | null;
}) {
  const rename = useRenameHousehold();
  const leave = useLeaveHousehold();
  const dissolve = useDeleteHousehold();
  const remove = useRemoveHouseholdMember();
  const transfer = useTransferHouseholdOwnership();
  const invite = useInviteToHousehold();
  const revoke = useRevokeHouseholdInvite();
  const invites = useHouseholdInvites(household.id);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(household.name);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const isOwner = role === 'OWNER';
  const active = members.filter((m) => m.left_at === null);
  const otherActive = active.filter((m) => m.user_id !== userId);

  async function run<T>(p: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    try {
      return await p();
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    }
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{household.name}</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          {active.length} of {household.max_members} members · you are the {role.toLowerCase()}
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-800 dark:text-red-200">
          {error}
        </div>
      )}

      {isOwner && (
        <div className="space-y-2">
          {renaming ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await run(() => rename.mutateAsync({ id: household.id, name: newName.trim() }));
                setRenaming(false);
              }}
              className="flex items-center gap-2"
            >
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={80}
                className="rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 text-sm"
              />
              <button
                type="submit"
                className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1 text-sm font-medium text-white dark:text-stone-900"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setRenaming(false)}
                className="rounded-md px-3 py-1 text-sm"
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              onClick={() => setRenaming(true)}
              className="text-sm text-stone-700 dark:text-stone-300 underline-offset-2 hover:underline"
            >
              Rename household
            </button>
          )}
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold">Members</h2>
        <ul className="mt-2 divide-y divide-stone-200 dark:divide-stone-700 rounded-md border border-stone-200 dark:border-stone-700">
          {active.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between px-3 py-2 text-sm"
              data-testid={`member-${m.user_id}`}
            >
              <div>
                <p className="font-medium">{m.display_name ?? '(unnamed)'}</p>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  {m.role} · joined {new Date(m.joined_at).toLocaleDateString()}
                </p>
              </div>
              {isOwner && m.user_id !== userId && (
                <div className="flex gap-2">
                  <button
                    onClick={() =>
                      confirm(`Make ${m.display_name ?? 'this member'} the owner?`) &&
                      void run(() => transfer.mutateAsync(m.user_id))
                    }
                    className="rounded-md px-2 py-1 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
                  >
                    Transfer
                  </button>
                  <button
                    onClick={() =>
                      confirm(`Remove ${m.display_name ?? 'this member'}?`) &&
                      void run(() => remove.mutateAsync(m.user_id))
                    }
                    className="rounded-md px-2 py-1 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {isOwner && (
        <div>
          <h2 className="text-lg font-semibold">Invites</h2>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
            Send the link to someone you want to share your collections with. Invites expire after
            7 days and can only be used once.
          </p>
          <button
            onClick={async () => {
              const token = await run(() => invite.mutateAsync(household.id));
              if (token) setInviteLink(`${location.origin}/household/join?token=${token}`);
            }}
            disabled={invite.isPending || active.length >= household.max_members}
            className="mt-2 rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 disabled:opacity-60"
          >
            {invite.isPending ? 'Creating…' : 'Create invite link'}
          </button>
          {active.length >= household.max_members && (
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Household is full — remove a member before inviting another.
            </p>
          )}
          {inviteLink && (
            <div
              data-testid="invite-link"
              className="mt-3 rounded-md border border-stone-300 dark:border-stone-600 bg-stone-50 dark:bg-stone-800 px-3 py-2 text-sm break-all"
            >
              {inviteLink}
            </div>
          )}
          {invites.data && invites.data.length > 0 && (
            <ul className="mt-3 divide-y divide-stone-200 dark:divide-stone-700 rounded-md border border-stone-200 dark:border-stone-700 text-sm">
              {invites.data.map((inv) => {
                const expired = new Date(inv.expires_at).getTime() < Date.now();
                const status = inv.used_at
                  ? 'Used'
                  : inv.revoked_at
                  ? 'Revoked'
                  : expired
                  ? 'Expired'
                  : 'Pending';
                return (
                  <li key={inv.id} className="flex items-center justify-between px-3 py-2">
                    <span>
                      <code className="text-xs">{inv.token.slice(0, 8)}…</code>
                      <span className="ml-2 text-stone-500">{status}</span>
                      <span className="ml-2 text-xs text-stone-400">
                        expires {new Date(inv.expires_at).toLocaleString()}
                      </span>
                    </span>
                    {!inv.used_at && !inv.revoked_at && !expired && (
                      <button
                        onClick={() => void run(() => revoke.mutateAsync(inv.id))}
                        className="rounded-md px-2 py-1 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
                      >
                        Revoke
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="pt-4 border-t border-stone-200 dark:border-stone-700">
        <h2 className="text-lg font-semibold">Recent activity</h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Append-only log of household and sharing actions. Visible to household members and to
          platform admins. Used to defend DMCA takedowns and investigate abuse.
        </p>
        <div className="mt-3">
          <AuditLogSection />
        </div>
      </div>

      <div className="pt-4 border-t border-stone-200 dark:border-stone-700">
        {isOwner && otherActive.length === 0 ? (
          <button
            onClick={() =>
              confirm('Delete this household? Any collections shared with it will be unshared.') &&
              void run(() => dissolve.mutateAsync(household.id))
            }
            className="rounded-md px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
          >
            Delete household
          </button>
        ) : (
          <button
            onClick={() =>
              confirm('Leave this household? You\'ll have a 7-day cooldown before rejoining.') &&
              void run(() => leave.mutateAsync())
            }
            disabled={isOwner && otherActive.length > 0}
            title={
              isOwner && otherActive.length > 0
                ? 'Transfer ownership first'
                : undefined
            }
            className="rounded-md px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-60"
          >
            Leave household
          </button>
        )}
      </div>
    </section>
  );
}
