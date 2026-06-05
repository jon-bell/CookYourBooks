import { supabase } from '../supabase.js';
import { CURRENT_TOS_VERSION as _CURRENT_TOS_VERSION } from '../legal/content.js';

// Re-export so existing callers (AcceptTosGate, etc.) don't need to change
// their import path.
export { CURRENT_TOS_VERSION } from '../legal/content.js';

// Errors raised by the RPCs use Postgres SQLSTATE P0001 with a human
// message; supabase-js surfaces both through `error.message`. Callers
// just rethrow — the dialogs and pages render the message verbatim.

export type HouseholdRole = 'OWNER' | 'MEMBER';

export interface Household {
  id: string;
  name: string;
  owner_id: string;
  max_members: number;
  created_at: string;
  updated_at: string;
}

export interface HouseholdMember {
  id: string;
  household_id: string;
  user_id: string;
  role: HouseholdRole;
  joined_at: string;
  left_at: string | null;
  attested_tos_version: number;
  /** Whether this member shares their whole library with the household. */
  library_shared: boolean;
  library_share_attested_at: string | null;
  library_share_attestation: string | null;
}

export interface HouseholdMemberWithProfile extends HouseholdMember {
  display_name: string | null;
}

export interface HouseholdInvite {
  id: string;
  household_id: string;
  token: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  revoked_at: string | null;
}

export interface HouseholdInvitePreview {
  household_id: string;
  household_name: string;
  invited_by_name: string | null;
  expires_at: string;
  revoked: boolean;
  used: boolean;
}

export interface HouseholdCooldown {
  user_id: string;
  eligible_at: string;
  reason: string | null;
}

export interface AuditLogRow {
  id: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  household_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ---------- Reads ----------

/** Active household for the caller, or null. */
export async function getMyHousehold(): Promise<{
  household: Household;
  members: HouseholdMemberWithProfile[];
  role: HouseholdRole;
  /** Whether the caller currently shares their library with this household. */
  libraryShared: boolean;
} | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: memberRows, error: memberErr } = await supabase
    .from('household_members')
    .select('*')
    .is('left_at', null);
  if (memberErr) throw memberErr;
  const mine = (memberRows as HouseholdMember[]).find((r) => r.user_id === user.id);
  if (!mine) return null;

  const { data: householdRow, error: hhErr } = await supabase
    .from('households')
    .select('*')
    .eq('id', mine.household_id)
    .single();
  if (hhErr) throw hhErr;
  const household = householdRow as Household;

  // Hydrate display names for the members list — purely for UI labels.
  const memberIds = (memberRows as HouseholdMember[])
    .filter((m) => m.household_id === household.id)
    .map((m) => m.user_id);
  const { data: profileRows } = await supabase
    .from('profiles')
    .select('id, display_name')
    .in('id', memberIds);
  const nameById = new Map(
    ((profileRows as { id: string; display_name: string | null }[]) ?? []).map((p) => [
      p.id,
      p.display_name,
    ]),
  );
  const members: HouseholdMemberWithProfile[] = (memberRows as HouseholdMember[])
    .filter((m) => m.household_id === household.id)
    .map((m) => ({ ...m, display_name: nameById.get(m.user_id) ?? null }));

  return { household, members, role: mine.role, libraryShared: mine.library_shared };
}

/** Pending invites for the caller's household (owner-visible). */
export async function listMyHouseholdInvites(
  householdId: string,
): Promise<HouseholdInvite[]> {
  const { data, error } = await supabase
    .from('household_invites')
    .select('*')
    .eq('household_id', householdId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as HouseholdInvite[]) ?? [];
}

/** Current cooldown floor (or null if eligible now). */
export async function getMyCooldown(): Promise<HouseholdCooldown | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('household_join_cooldowns')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return null;
  if (!data) return null;
  const row = data as HouseholdCooldown;
  if (new Date(row.eligible_at).getTime() <= Date.now()) return null;
  return row;
}

/** Preview a household for an invite token (works for invitees pre-acceptance). */
export async function previewInvite(token: string): Promise<HouseholdInvitePreview | null> {
  const { data, error } = await supabase.rpc('preview_household_invite', { p_token: token });
  if (error) throw error;
  const rows = data as HouseholdInvitePreview[] | null;
  return rows && rows.length > 0 ? rows[0]! : null;
}

/** Audit log entries scoped to the user (their actions + their household). */
export async function listMyAuditLog(opts: { limit?: number } = {}): Promise<AuditLogRow[]> {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 100);
  if (error) throw error;
  return (data as AuditLogRow[]) ?? [];
}

// ---------- Mutations ----------

export async function createHousehold(name: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_household', { p_name: name });
  if (error) throw error;
  return data as string;
}

export async function renameHousehold(householdId: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('rename_household', {
    p_household_id: householdId,
    p_name: name,
  });
  if (error) throw error;
}

export async function deleteHousehold(householdId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_household', { p_household_id: householdId });
  if (error) throw error;
}

export async function inviteToHousehold(householdId: string): Promise<string> {
  const { data, error } = await supabase.rpc('invite_to_household', {
    p_household_id: householdId,
  });
  if (error) throw error;
  return data as string;
}

export async function revokeHouseholdInvite(inviteId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_household_invite', { p_invite_id: inviteId });
  if (error) throw error;
}

export async function acceptHouseholdInvite(token: string): Promise<string> {
  const { data, error } = await supabase.rpc('accept_household_invite', { p_token: token });
  if (error) throw error;
  return data as string;
}

export async function leaveHousehold(): Promise<void> {
  const { error } = await supabase.rpc('leave_household');
  if (error) throw error;
}

export async function removeHouseholdMember(userId: string): Promise<void> {
  const { error } = await supabase.rpc('remove_household_member', { p_user_id: userId });
  if (error) throw error;
}

export async function transferHouseholdOwnership(newOwnerId: string): Promise<void> {
  const { error } = await supabase.rpc('transfer_household_ownership', {
    p_new_owner_id: newOwnerId,
  });
  if (error) throw error;
}

/**
 * Toggle whether the caller shares their whole library with the given
 * household. Enabling requires the one-time rights attestation; the
 * server records it in audit_log. Disabling needs no attestation.
 */
export async function setLibrarySharing(
  householdId: string,
  enabled: boolean,
  attestation?: string,
): Promise<void> {
  const { error } = await supabase.rpc('set_library_sharing', {
    p_household_id: householdId,
    p_enabled: enabled,
    p_attestation: attestation ?? undefined,
  });
  if (error) throw error;
}

/** Step 1 of household→public escalation. Records a fresh public-scope
 *  attestation so the DB cascade trigger lets the subsequent is_public
 *  flip through. */
export async function attestPublicShare(
  collectionId: string,
  attestation: string,
): Promise<void> {
  const { error } = await supabase.rpc('attest_public_share', {
    p_collection_id: collectionId,
    p_attestation: attestation,
  });
  if (error) throw error;
}

// ---------- Terms of Service ----------

export async function acceptTos(version: number = _CURRENT_TOS_VERSION): Promise<void> {
  const { error } = await supabase.rpc('accept_tos', { p_version: version });
  if (error) throw error;
}

export async function getMyTosVersion(): Promise<number> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;
  const { data, error } = await supabase
    .from('profiles')
    .select('tos_version')
    .eq('id', user.id)
    .single();
  if (error) return 0;
  return ((data as { tos_version?: number } | null)?.tos_version ?? 0) as number;
}

/** True iff the supabase error came from the require_current_tos guard. */
export function isTosNotAcceptedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = (err as { message?: string }).message ?? '';
  return msg.startsWith('TOS_NOT_ACCEPTED');
}
