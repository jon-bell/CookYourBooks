/**
 * Decide whether a bulk write into cr-sqlite CRR tables should suspend
 * the per-row change-tracking triggers (via crsql_begin_alter /
 * crsql_commit_alter) for the duration.
 *
 * The catch: commit_alter is a *schema-migration* primitive — it rebuilds
 * the table's CRDT clock by scanning the WHOLE table, so its cost scales
 * with the table size, not with how many rows we just wrote. Suspending
 * triggers is a big win amortised over a large cold-hydrate batch, but a
 * catastrophe for the steady state: an incremental pull of a single
 * changed recipe was paying a full 20s+ commit_alter over a large library
 * on every realtime echo. Per-row trigger fires are ~10–15ms on iPad
 * WASM, so below the threshold plain tracked inserts are far cheaper than
 * one table-sized commit_alter.
 *
 * Kept as a standalone pure function so the threshold decision is unit
 * testable without standing up the WASM SQLite db.
 */
export const CRR_SUPPRESS_MIN_ROWS = 200;

export function shouldSuppressCrrTriggers(rowCount: number): boolean {
  return rowCount >= CRR_SUPPRESS_MIN_ROWS;
}
