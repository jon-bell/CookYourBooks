import type { ImportItem } from './model.js';

/**
 * Pure grouping model shared by the import organizer. The screen holds
 * `removedSplits` (a Set of split indices that have been TAKEN AWAY, merging
 * the two neighboring pages into one recipe) and derives everything from it,
 * so the surface interaction (tap-a-connector, select-and-group, …) can be
 * swapped without touching this logic. Indices are positions in the
 * page_index-sorted `groupable` list; split `i` sits between item `i` and
 * item `i + 1`.
 */

/** Immutably toggle membership of `idx` in a Set. */
export function toggleInSet(set: ReadonlySet<number>, idx: number): Set<number> {
  const next = new Set(set);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  return next;
}

/** Every split index (0..pageCount-2) removed — collapse into one recipe. */
export function mergeAllSplits(pageCount: number): Set<number> {
  const all = new Set<number>();
  for (let i = 0; i < pageCount - 1; i += 1) all.add(i);
  return all;
}

/**
 * Walk page-ordered items left-to-right, starting a new group whenever the
 * split AFTER the previous item is still present (i.e. its index is NOT in
 * `removedSplits`). A removed split folds the item into the current group.
 */
export function deriveGroups(
  groupable: readonly ImportItem[],
  removedSplits: ReadonlySet<number>,
): ImportItem[][] {
  if (groupable.length === 0) return [];
  const out: ImportItem[][] = [[groupable[0]!]];
  for (let i = 1; i < groupable.length; i += 1) {
    if (removedSplits.has(i - 1)) out[out.length - 1]!.push(groupable[i]!);
    else out.push([groupable[i]!]);
  }
  return out;
}

/** `[[primaryId, ...absorbedIds], …]` payload for `import_finalize_grouping`. */
export function buildFinalizePayload(groups: readonly (readonly ImportItem[])[]): string[][] {
  return groups.map((g) => g.map((it) => it.id));
}
