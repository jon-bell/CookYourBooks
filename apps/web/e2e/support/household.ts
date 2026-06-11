import type { Page } from '@playwright/test';

import type { TestUser } from './admin.js';
import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './env.js';

// Helpers for the household e2e suite. Direct service-role inserts are
// used for setup (creating a 5-member household quickly) so that the
// UI-level RPC paths in the actual spec start from a known state
// without burning ten UI flows just to populate prereqs.

interface JsonReq {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function rest<T = unknown>(path: string, init: JsonReq = {}): Promise<T> {
  const resp = await fetch(`${SUPABASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!resp.ok) {
    throw new Error(`REST ${init.method ?? 'GET'} ${path}: ${resp.status} ${await resp.text()}`);
  }
  const text = await resp.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Insert a household + owner row using the service role. Bypasses the
 *  per-user RPC guards (cap / cooldown / one-active) — only use for
 *  populating setup state, never for testing the actual flows. */
export async function seedHousehold(opts: {
  ownerId: string;
  name: string;
  maxMembers?: number;
}): Promise<{ householdId: string }> {
  const [household] = await rest<{ id: string }[]>('/rest/v1/households', {
    method: 'POST',
    body: {
      owner_id: opts.ownerId,
      name: opts.name,
      max_members: opts.maxMembers ?? 6,
    },
  });
  if (!household) throw new Error('seedHousehold: no row returned');
  await rest('/rest/v1/household_members', {
    method: 'POST',
    body: {
      household_id: household.id,
      user_id: opts.ownerId,
      role: 'OWNER',
    },
  });
  return { householdId: household.id };
}

/** Add a member to a household directly. Same caveats as seedHousehold. */
export async function seedMembership(opts: { householdId: string; userId: string }): Promise<void> {
  await rest('/rest/v1/household_members', {
    method: 'POST',
    body: {
      household_id: opts.householdId,
      user_id: opts.userId,
      role: 'MEMBER',
    },
  });
}

/** Mark a user as having accepted the current ToS. Service role only. */
export async function acceptTosViaService(userId: string, version = 1): Promise<void> {
  await rest(`/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    body: { tos_version: version, tos_accepted_at: new Date().toISOString() },
  });
}

/** Fetch the audit-log rows the service role can see (i.e. all of them). */
export async function listAuditLog(filter: {
  actorId?: string;
  householdId?: string;
  action?: string;
}): Promise<Array<{ id: string; action: string; metadata: Record<string, unknown> }>> {
  const parts: string[] = ['select=id,action,actor_id,household_id,metadata,created_at'];
  if (filter.actorId) parts.push(`actor_id=eq.${filter.actorId}`);
  if (filter.householdId) parts.push(`household_id=eq.${filter.householdId}`);
  if (filter.action) parts.push(`action=eq.${filter.action}`);
  parts.push('order=created_at.desc');
  return rest(`/rest/v1/audit_log?${parts.join('&')}`);
}

/** Drop any household, membership, cooldown, audit row tied to the
 *  given users. Idempotent. Call from afterEach. */
export async function cleanupHouseholdFor(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const inList = `(${userIds.join(',')})`;
  // Order matters: household_members FK to households via cascade, but
  // households FK to profiles via cascade too — we only delete what's
  // explicitly user-owned to be safe.
  await rest(`/rest/v1/household_members?user_id=in.${inList}`, { method: 'DELETE' });
  await rest(`/rest/v1/households?owner_id=in.${inList}`, { method: 'DELETE' });
  await rest(`/rest/v1/household_join_cooldowns?user_id=in.${inList}`, { method: 'DELETE' });
}

/** Read the invite link rendered by the owner-side /household page. */
export async function readInviteToken(page: Page): Promise<string> {
  const text = await page.getByTestId('invite-link').textContent();
  const match = text?.match(/token=([a-f0-9]+)/);
  if (!match) throw new Error(`No invite token in link text: ${text}`);
  return match[1]!;
}

/**
 * Sign in via the UI as a specific user, navigate to the join URL with
 * a token, and accept. Returns when the post-accept /household page is
 * visible.
 */
export async function joinHouseholdViaInvite(
  page: Page,
  user: TestUser,
  token: string,
): Promise<void> {
  const { signIn } = await import('./fixtures.js');
  // signIn waits for the library heading (i.e. the user is fully
  // authenticated and sync has run a cycle) before returning — without
  // that, navigating to the join page can race AuthProvider's
  // getSession() resolution and render the "Sign in to join" view.
  await signIn(page, user);
  await page.goto(`/household/join?token=${token}`);
  await page.getByRole('button', { name: 'Join household' }).click();
  await page.waitForURL(/\/household$/);
}

export { rest as householdRest };
