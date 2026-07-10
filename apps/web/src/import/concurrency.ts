/** One item's failure from {@link mapWithConcurrency}. */
export interface ConcurrencyFailure<T> {
  item: T;
  index: number;
  error: Error;
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight (the shared-index
 * worker-pool shape used inline by uploadBatch). Unlike `Promise.all`, one
 * rejection never aborts the rest: failures are collected and returned so the
 * caller can report an aggregate ("N of M failed") after everything settles.
 *
 * `onSettled` fires once per item as it finishes (success or failure), in
 * completion order — use it for progress counters.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  onSettled?: (result: { item: T; index: number; error?: Error }) => void,
): Promise<ConcurrencyFailure<T>[]> {
  const failures: ConcurrencyFailure<T>[] = [];
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i]!;
      try {
        await fn(item, i);
        onSettled?.({ item, index: i });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        failures.push({ item, index: i, error });
        onSettled?.({ item, index: i, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return failures;
}
