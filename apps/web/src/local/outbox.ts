import { getLocalDb } from './db.js';

export type OutboxKind =
  | 'collection_save'
  | 'collection_delete'
  | 'recipe_save'
  | 'recipe_delete'
  // Fires when the user drags a recipe to a new position. Push reads the
  // local sort_order and pushes only that column — no child rewrite.
  | 'recipe_reorder'
  // Bulk OCR import: the worker owns most columns on these rows. The
  // client only pushes user-editable annotations (assignments, status
  // moves to REVIEWED / DISCARDED, batch settings, etc).
  | 'import_batch_insert'
  | 'import_batch_update'
  | 'import_item_insert'
  | 'import_item_update'
  // Per-user HOUSE conversion rules. Pushed via the
  // house_conversion_upsert / house_conversion_delete RPCs.
  | 'conversion_rule_save'
  | 'conversion_rule_delete'
  // Browser-computed recipe embedding ready to push to pgvector via the
  // embed_upsert_client RPC. The entity_id is the recipe id; the
  // payload lives in the local recipe_embeddings row.
  | 'embedding_push'
  // Cooking tracker (2026-06-17). Plain PostgREST upsert/delete — no RPC.
  | 'cooking_event_save'
  | 'cooking_event_delete'
  | 'recipe_tag_save'
  | 'recipe_tag_delete'
  // Collection "general notes" (OCR'd intro pages or hand-written). Plain
  // PostgREST upsert/delete on collection_notes — no RPC.
  | 'collection_note_save'
  | 'collection_note_delete';

export interface OutboxEntry {
  id: number;
  kind: OutboxKind;
  entity_id: string;
  collection_id: string | null;
  enqueued_at: number;
  attempts: number;
  last_error: string | null;
}

export async function enqueue(entry: {
  kind: OutboxKind;
  entity_id: string;
  collection_id?: string;
}): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `insert into outbox (kind, entity_id, collection_id, enqueued_at) values (?,?,?,?)`,
    [entry.kind, entry.entity_id, entry.collection_id ?? null, Date.now()],
  );
}

export async function listPending(limit = 1000): Promise<OutboxEntry[]> {
  const db = await getLocalDb();
  const rows = (await db.execO<OutboxEntry>(
    `select id, kind, entity_id, collection_id, enqueued_at, attempts, last_error
       from outbox
      order by id asc
      limit ?`,
    [limit],
  )) as OutboxEntry[];
  return rows;
}

export async function markDone(id: number): Promise<void> {
  const db = await getLocalDb();
  await db.exec(`delete from outbox where id = ?`, [id]);
}

export async function markFailed(id: number, error: string): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `update outbox set attempts = attempts + 1, last_error = ? where id = ?`,
    [error, id],
  );
}

/**
 * Of the given entity ids, return the ones that have a pending delete of
 * `kind` sitting in the outbox. The sync apply paths use this to keep a
 * stale pull response (or a realtime INSERT echo) from resurrecting a row
 * the user deleted locally while the fetch was in flight: pulls only ever
 * upsert, and owner-filtered realtime DELETE events don't deliver (the old
 * record carries just the PK), so a resurrected hard-deleted row would be
 * permanent. Soft-deleted tables (recipes, collections) don't need this —
 * their tombstone row wins the updated_at freshness compare instead.
 */
export async function pendingDeleteIds(
  kind: OutboxKind,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const db = await getLocalDb();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const rows = (await db.execO<{ entity_id: string }>(
      `select entity_id from outbox where kind = ? and entity_id in (${ph})`,
      [kind, ...slice],
    )) as { entity_id: string }[];
    for (const r of rows) out.add(r.entity_id);
  }
  return out;
}

export async function countPending(): Promise<number> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ c: number }>(`select count(*) as c from outbox`)) as {
    c: number;
  }[];
  return rows[0]?.c ?? 0;
}

/** Debug helper: read the full outbox queue for the diagnostics panel. */
export async function listOutboxForDebug(limit = 2000): Promise<OutboxEntry[]> {
  return listPending(limit);
}

/** Debug helper: counts grouped by kind, for at-a-glance triage. */
export async function outboxKindCounts(): Promise<Record<string, number>> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ kind: string; c: number }>(
    `select kind, count(*) as c from outbox group by kind`,
  )) as { kind: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.c;
  return out;
}
