/**
 * Decide whether a bulk write into cr-sqlite CRR tables should suspend
 * the per-row change-tracking triggers (via crsql_begin_alter /
 * crsql_commit_alter) for the duration.
 *
 * The catch: commit_alter is a *schema-migration* primitive — it rebuilds
 * the table's CRDT clock by scanning the WHOLE table, so its cost scales
 * with the table size, not with how many rows we just wrote. Per-row
 * trigger fires are ~10–15ms on iPad WASM.
 *
 * The decision is therefore *size-relative*, not an absolute row count.
 * Two guards, both must hold to suppress:
 *
 *  1. {@link CRR_SUPPRESS_MIN_ROWS} floor — a tiny batch (a realtime echo of
 *     one changed recipe) never justifies a full-table scan, whatever the
 *     table size. This also lets the caller skip the count() probe on the
 *     hot path.
 *  2. {@link CRR_SUPPRESS_MIN_FRACTION} of the largest target table — because
 *     commit_alter is O(table size), suppression only wins when the batch is
 *     a large fraction of the table it scans. The original absolute-200
 *     threshold inverted on big libraries: an incremental pull of ~500 rows
 *     into a 160k-row `ingredients` table paid a ~50s commit_alter to dodge a
 *     few hundred ~12ms trigger fires, wedging the pull past the watchdog.
 *     A cold hydrate (table currently empty → maxTableRows 0) and a
 *     whole-library re-pull (batch ≈ table) both clear this; an incremental
 *     pull never does.
 *
 * Kept as a standalone pure function so the threshold decision is unit
 * testable without standing up the WASM SQLite db. `maxTableRows` is the
 * current row count of the largest table the batch will write to.
 */
export const CRR_SUPPRESS_MIN_ROWS = 200;
export const CRR_SUPPRESS_MIN_FRACTION = 0.5;

export function shouldSuppressCrrTriggers(rowCount: number, maxTableRows: number): boolean {
  if (rowCount < CRR_SUPPRESS_MIN_ROWS) return false;
  return rowCount >= maxTableRows * CRR_SUPPRESS_MIN_FRACTION;
}
