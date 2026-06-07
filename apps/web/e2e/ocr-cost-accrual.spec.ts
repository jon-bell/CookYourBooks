import { test, expect } from '@playwright/test';
import { createTestUser, type TestUser } from './support/admin.js';
import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';

// Validates the cost-accrual fix: import_fail (not just import_complete) must
// roll an attempt's cost onto import_items.cost_usd_micros, so a batch total
// includes failed + recitation-fallback attempts. Driven directly through the
// service-role RPCs — no OCR/network needed.

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

async function itemCost(itemId: string): Promise<number> {
  const r = await svc(`/rest/v1/import_items?id=eq.${itemId}&select=cost_usd_micros,status`);
  const rows = (await r.json()) as Array<{ cost_usd_micros: number }>;
  return rows[0]?.cost_usd_micros ?? -1;
}

test.describe('OCR cost accrual', () => {
  test('failed and completed attempts both accrue onto the item', async () => {
    test.setTimeout(60_000);
    const owner = await createTestUser('cost-owner');
    const cleanup: TestUser[] = [owner];
    let batchId: string | undefined;
    try {
      const batchResp = await svc('/rest/v1/import_batches', {
        method: 'POST',
        body: JSON.stringify({
          owner_id: owner.id,
          name: 'Cost batch',
          source_kind: 'IMAGES',
          default_provider: 'gemini',
          default_model: 'gemini-3.1-flash-lite',
          status: 'OPEN',
          total_items: 1,
        }),
      });
      batchId = ((await batchResp.json()) as Array<{ id: string }>)[0]!.id;

      const itemResp = await svc('/rest/v1/import_items', {
        method: 'POST',
        body: JSON.stringify({
          batch_id: batchId,
          owner_id: owner.id,
          page_index: 0,
          status: 'CLAIMED',
          claim_token: 'tok-1',
        }),
      });
      const itemId = ((await itemResp.json()) as Array<{ id: string }>)[0]!.id;

      // A failed attempt that still burned tokens (e.g. RECITATION → fallback).
      const fail = await svc('/rest/v1/rpc/import_fail', {
        method: 'POST',
        body: JSON.stringify({
          p_item_id: itemId,
          p_claim_token: 'tok-1',
          p_attempt: {
            provider: 'gemini',
            model: 'gemini-3.1-flash-lite',
            error_kind: 'RECITATION',
            error_message: 'blocked',
            prompt_tokens: 100,
            completion_tokens: 200,
            cost_usd_micros: 5000,
          },
          p_next_state: 'NEEDS_FALLBACK',
        }),
      });
      expect(fail.status).toBeLessThan(300);
      // Before the fix this was 0 — the failed attempt's cost was dropped.
      expect(await itemCost(itemId)).toBe(5000);

      // Re-claim, then a successful fallback attempt accrues on top.
      await svc(`/rest/v1/import_items?id=eq.${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'CLAIMED', claim_token: 'tok-2' }),
      });
      const done = await svc('/rest/v1/rpc/import_complete', {
        method: 'POST',
        body: JSON.stringify({
          p_item_id: itemId,
          p_claim_token: 'tok-2',
          p_parsed_drafts: [],
          p_attempt: {
            provider: 'gemini',
            model: 'gemini-3.1-flash-lite',
            error_kind: 'OK',
            prompt_tokens: 100,
            completion_tokens: 200,
            cost_usd_micros: 3000,
          },
        }),
      });
      expect(done.status).toBeLessThan(300);
      expect(await itemCost(itemId)).toBe(8000); // 5000 (failed) + 3000 (completed)
    } finally {
      if (batchId) {
        await svc(`/rest/v1/import_batches?id=eq.${batchId}`, { method: 'DELETE' }).catch(() => {});
      }
      await Promise.all(cleanup.map((u) => u.cleanup()));
    }
  });
});
