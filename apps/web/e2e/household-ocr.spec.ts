import { test, expect } from '@playwright/test';
import { createTestUser, type TestUser } from './support/admin.js';
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';
import { seedHousehold, seedMembership, cleanupHouseholdFor } from './support/household.js';

// Security-critical coverage for shared household OCR. No browser/OCR
// needed — these assert the RPC + RLS contract directly:
//   - owner-only write of the shared config
//   - the worker's service-role-only key resolver borrows the owner's key
//     for a keyless member, with provider containment
//   - members / non-members / left members can't pull the key
//   - the resolver is NOT callable by `authenticated`

async function userToken(u: TestUser): Promise<string> {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: u.email, password: u.password }),
  });
  if (!resp.ok) throw new Error(`token grant: ${resp.status} ${await resp.text()}`);
  return ((await resp.json()) as { access_token: string }).access_token;
}

async function rpc(
  fn: string,
  params: Record<string, unknown>,
  auth: { token: string; apikey: string },
): Promise<{ status: number; body: string }> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: auth.apikey,
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  return { status: resp.status, body: await resp.text() };
}

const asService = { token: SUPABASE_SERVICE_ROLE, apikey: SUPABASE_SERVICE_ROLE };

test.describe('Household shared OCR', () => {
  test('owner-only config + key borrowing with provider containment', async () => {
    test.setTimeout(60_000);
    const owner = await createTestUser('ocr-owner');
    const member = await createTestUser('ocr-member');
    const outsider = await createTestUser('ocr-outsider');
    const created: TestUser[] = [owner, member, outsider];
    try {
      const [ownerTok, memberTok, outsiderTok] = await Promise.all([
        userToken(owner),
        userToken(member),
        userToken(outsider),
      ]);
      const ownerAuth = { token: ownerTok, apikey: SUPABASE_ANON_KEY };
      const memberAuth = { token: memberTok, apikey: SUPABASE_ANON_KEY };

      // Owner has a Gemini key; member has none.
      const setKey = await rpc(
        'ocr_key_set',
        { p_provider: 'gemini', p_raw_key: 'test-gemini-key-1234567890' },
        ownerAuth,
      );
      expect(setKey.status).toBe(204);

      const { householdId } = await seedHousehold({ ownerId: owner.id, name: 'OCR House' });
      await seedMembership({ householdId, userId: member.id });

      // Member cannot set the shared config (owner-only).
      const memberWrite = await rpc(
        'set_household_ocr_config',
        {
          p_household_id: householdId,
          p_enabled: true,
          p_provider: 'gemini',
          p_model: 'gemini-3.1-flash-lite',
        },
        memberAuth,
      );
      expect(memberWrite.status).toBeGreaterThanOrEqual(400);
      expect(memberWrite.body).toContain('owner');

      // Owner enables sharing.
      const ownerWrite = await rpc(
        'set_household_ocr_config',
        {
          p_household_id: householdId,
          p_enabled: true,
          p_provider: 'gemini',
          p_model: 'gemini-3.1-flash-lite',
        },
        ownerAuth,
      );
      expect(ownerWrite.status).toBe(204);

      // Worker (service role) resolves the borrowed key for the keyless member.
      const borrowed = await rpc(
        'ocr_resolve_effective_key',
        { p_owner_id: member.id, p_provider: 'gemini' },
        asService,
      );
      expect(borrowed.status).toBe(200);
      const borrowedRows = JSON.parse(borrowed.body) as Array<{
        api_key: string;
        key_owner_id: string;
      }>;
      expect(borrowedRows).toHaveLength(1);
      expect(borrowedRows[0]!.api_key).toBe('test-gemini-key-1234567890');
      expect(borrowedRows[0]!.key_owner_id).toBe(owner.id);

      // Provider containment: the shared provider is gemini, so a request
      // for openai-compatible must NOT borrow the owner's key.
      const wrongProvider = await rpc(
        'ocr_resolve_effective_key',
        { p_owner_id: member.id, p_provider: 'openai-compatible' },
        asService,
      );
      expect(JSON.parse(wrongProvider.body)).toHaveLength(0);

      // Outsider (not in the household) gets nothing.
      const outsiderResolve = await rpc(
        'ocr_resolve_effective_key',
        { p_owner_id: outsider.id, p_provider: 'gemini' },
        asService,
      );
      expect(JSON.parse(outsiderResolve.body)).toHaveLength(0);

      // The resolver is NOT callable by an authenticated user (would leak keys).
      const memberCallsResolver = await rpc(
        'ocr_resolve_effective_key',
        { p_owner_id: owner.id, p_provider: 'gemini' },
        memberAuth,
      );
      expect(memberCallsResolver.status).toBeGreaterThanOrEqual(400);

      // Outsider can't even read the household_ocr_config row (RLS).
      const cfgRead = await fetch(
        `${SUPABASE_URL}/rest/v1/household_ocr_config?select=household_id`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${outsiderTok}` } },
      );
      expect(JSON.parse(await cfgRead.text())).toHaveLength(0);

      // A member who has left loses the borrow.
      await fetch(
        `${SUPABASE_URL}/rest/v1/household_members?household_id=eq.${householdId}&user_id=eq.${member.id}`,
        {
          method: 'PATCH',
          headers: {
            apikey: SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ left_at: new Date().toISOString() }),
        },
      );
      const afterLeave = await rpc(
        'ocr_resolve_effective_key',
        { p_owner_id: member.id, p_provider: 'gemini' },
        asService,
      );
      expect(JSON.parse(afterLeave.body)).toHaveLength(0);
    } finally {
      await cleanupHouseholdFor(created.map((u) => u.id)).catch(() => {});
      await Promise.all(created.map((u) => u.cleanup()));
    }
  });
});
