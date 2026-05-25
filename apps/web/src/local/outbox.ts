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
  | 'conversion_rule_delete';

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

export async function listPending(limit = 50): Promise<OutboxEntry[]> {
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

export async function countPending(): Promise<number> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ c: number }>(`select count(*) as c from outbox`)) as {
    c: number;
  }[];
  return rows[0]?.c ?? 0;
}
