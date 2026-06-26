import { expect, test } from '@playwright/test';

import { createTestUser, type TestUser } from './support/admin.js';
import { userAccessToken } from './support/embeddings.js';
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';
import { signIn } from './support/fixtures.js';
import { cleanupHouseholdFor, seedHousehold, seedMembership } from './support/household.js';

// LLM Cost Center contract + RLS tests. The page reads the security_invoker
// `llm_usage_report` view + `llm_usage_summary` RPC online, scoped by RLS to
// the caller + their (library-sharing) household. These tests drive the
// server contract directly through REST (service-role seeding, then reading
// AS a user with a real JWT — the only way RLS is enforced; the service role
// bypasses it).

async function svc(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
}

interface UsageRow {
  id: string;
  feature: string;
  owner_id: string;
  cost_usd_micros: number;
  produced_ref: string | null;
  [k: string]: unknown;
}

/** GET the view AS a user (RLS enforced via their JWT). */
async function viewAsUser(token: string, query = ''): Promise<UsageRow[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/llm_usage_report?select=*${query}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`viewAsUser ${r.status}: ${await r.text()}`);
  return (await r.json()) as UsageRow[];
}

/** Call the rollup RPC AS a user. */
async function summaryAsUser(
  token: string,
  groupBy: string,
): Promise<Array<{ bucket: string | null; member_id: string | null; cost_usd_micros: number }>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/llm_usage_summary`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_group_by: groupBy }),
  });
  if (!r.ok) throw new Error(`summaryAsUser ${r.status}: ${await r.text()}`);
  return (await r.json()) as Array<{
    bucket: string | null;
    member_id: string | null;
    cost_usd_micros: number;
  }>;
}

/** Seed one OCR attempt (via batch+item+import_complete) and return its item id
 *  (the view's produced_ref for the row). Exercises the redefined import_complete
 *  + the set_owned_row_household trigger. */
async function seedOcrAttempt(
  ownerId: string,
  cost: number,
): Promise<{ batchId: string; itemId: string }> {
  const batchId = (
    (await (
      await svc('/rest/v1/import_batches', {
        method: 'POST',
        body: JSON.stringify({
          owner_id: ownerId,
          name: 'Cost center batch',
          source_kind: 'IMAGES',
          default_provider: 'gemini',
          default_model: 'gemini-2.5-flash',
          status: 'OPEN',
          total_items: 1,
        }),
      })
    ).json()) as Array<{ id: string }>
  )[0]!.id;
  const itemId = (
    (await (
      await svc('/rest/v1/import_items', {
        method: 'POST',
        body: JSON.stringify({
          batch_id: batchId,
          owner_id: ownerId,
          page_index: 0,
          status: 'CLAIMED',
          claim_token: 'cc-tok',
        }),
      })
    ).json()) as Array<{ id: string }>
  )[0]!.id;
  const done = await svc('/rest/v1/rpc/import_complete', {
    method: 'POST',
    body: JSON.stringify({
      p_item_id: itemId,
      p_claim_token: 'cc-tok',
      p_parsed_drafts: [],
      p_attempt: {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        error_kind: 'OK',
        prompt_tokens: 100,
        completion_tokens: 200,
        cost_usd_micros: cost,
      },
    }),
  });
  expect(done.status).toBeLessThan(300);
  return { batchId, itemId };
}

/** Seed one ISBN-scan ledger row (the gap-coverage path the edge fn uses). */
async function seedMiscIsbn(ownerId: string, isbn: string, cost: number): Promise<void> {
  const r = await svc('/rest/v1/rpc/misc_llm_usage_record', {
    method: 'POST',
    body: JSON.stringify({
      p_event: {
        owner_id: ownerId,
        feature: 'isbn',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        prompt_tokens: 500,
        completion_tokens: 10,
        cost_usd_micros: cost,
        latency_ms: 120,
        error_kind: 'OK',
        produced_ref: isbn,
        produced_kind: 'ISBN',
      },
    }),
  });
  expect(r.status).toBeLessThan(300);
}

test.describe('LLM Cost Center', () => {
  test('a library-sharing household member sees co-members usage; outsiders do not', async () => {
    test.setTimeout(60_000);
    const owner = await createTestUser('cc-owner');
    const member = await createTestUser('cc-member');
    const outsider = await createTestUser('cc-outsider');
    const cleanup: TestUser[] = [owner, member, outsider];
    let batchId: string | undefined;
    try {
      // Household with owner + member, both library-sharing (default true).
      const { householdId } = await seedHousehold({ ownerId: owner.id, name: 'CC Household' });
      await seedMembership({ householdId, userId: member.id });

      // Seed the owner's usage AFTER the membership exists so the
      // set_owned_row_household trigger stamps household_id = householdId.
      ({ batchId } = await seedOcrAttempt(owner.id, 8000));
      await seedMiscIsbn(owner.id, '9780123456789', 1234);

      // The member's fresh token carries the household_id claim (the
      // custom_access_token_hook reads household_members at mint time).
      const memberToken = await userAccessToken(member.email, member.password);
      const seenByMember = await viewAsUser(memberToken, `&owner_id=eq.${owner.id}&order=feature`);
      const features = seenByMember.map((r) => r.feature).sort();
      expect(features).toEqual(['isbn', 'ocr']); // both arms visible across the household
      expect(seenByMember.reduce((a, r) => a + Number(r.cost_usd_micros), 0)).toBe(9234);

      // The member's rollup includes the owner's spend.
      const byMember = await summaryAsUser(memberToken, 'member');
      const ownerBucket = byMember.find((b) => b.member_id === owner.id);
      expect(ownerBucket && Number(ownerBucket.cost_usd_micros)).toBe(9234);

      // The outsider (no shared household) sees NONE of the owner's usage.
      const outsiderToken = await userAccessToken(outsider.email, outsider.password);
      const seenByOutsider = await viewAsUser(outsiderToken, `&owner_id=eq.${owner.id}`);
      expect(seenByOutsider).toHaveLength(0);
      const outsiderSummary = await summaryAsUser(outsiderToken, 'member');
      expect(outsiderSummary.find((b) => b.member_id === owner.id)).toBeUndefined();

      // Sanity: the service role (RLS-bypassing) DOES see the rows — proves
      // the boundary above is the JWT claim, not a missing row.
      const svcRows = (await (
        await svc(`/rest/v1/llm_usage_report?owner_id=eq.${owner.id}&select=id`)
      ).json()) as unknown[];
      expect(svcRows.length).toBe(2);
    } finally {
      if (batchId) {
        await svc(`/rest/v1/import_batches?id=eq.${batchId}`, { method: 'DELETE' }).catch(() => {});
      }
      await svc(`/rest/v1/misc_llm_usage?owner_id=eq.${owner.id}`, { method: 'DELETE' }).catch(
        () => {},
      );
      await cleanupHouseholdFor(cleanup.map((u) => u.id));
      await Promise.all(cleanup.map((u) => u.cleanup()));
    }
  });

  test('the report view never exposes key secrets', async () => {
    const owner = await createTestUser('cc-secret');
    try {
      await seedMiscIsbn(owner.id, '9781111111111', 42);
      const token = await userAccessToken(owner.email, owner.password);
      const rows = await viewAsUser(token, `&owner_id=eq.${owner.id}`);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).not.toHaveProperty('vault_secret_id');
        expect(row).not.toHaveProperty('api_key');
      }
    } finally {
      await svc(`/rest/v1/misc_llm_usage?owner_id=eq.${owner.id}`, { method: 'DELETE' }).catch(
        () => {},
      );
      await owner.cleanup();
    }
  });

  test('the cost center page renders the signed-in user usage', async ({ page }) => {
    test.setTimeout(60_000);
    const owner = await createTestUser('cc-ui');
    let batchId: string | undefined;
    try {
      ({ batchId } = await seedOcrAttempt(owner.id, 8000));
      await seedMiscIsbn(owner.id, '9782222222222', 1234);

      await signIn(page, owner);
      await page.goto('/cost');

      // The page reads the report view online; the first fetch races the
      // post-sign-in sync pull + vite's on-demand compile, so give it room.
      await expect(page.getByTestId('cost-center-table')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('cost-center-row-ocr').first()).toBeVisible();
      await expect(page.getByTestId('cost-center-row-isbn').first()).toBeVisible();
      // Total spend card is populated (sub-cent total renders with 4 decimals).
      await expect(page.getByTestId('cost-center-total')).toContainText('$0.00');
    } finally {
      if (batchId) {
        await svc(`/rest/v1/import_batches?id=eq.${batchId}`, { method: 'DELETE' }).catch(() => {});
      }
      await svc(`/rest/v1/misc_llm_usage?owner_id=eq.${owner.id}`, { method: 'DELETE' }).catch(
        () => {},
      );
      await owner.cleanup();
    }
  });
});
