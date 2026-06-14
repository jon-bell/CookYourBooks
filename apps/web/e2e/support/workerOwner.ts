// Per-test owner scope for worker pumps.
//
// The import-worker now accepts `only_owner` to drain just one user's jobs (see
// migration 20260703000000). To make every worker-backed spec parallel-safe
// without editing each call site, the `user` fixture records the test's user id
// here; `triggerWorker`/`pumpWorker`/`waitForEmbedding` default their owner
// scope to it. Multi-user specs (created via `createTestUser`, not the fixture)
// pass an explicit ownerId where they pump for a specific user.
//
// Safe as module state: Playwright runs one test at a time PER worker process,
// and these helpers run in that same process — so there's no within-process
// concurrency to race on. Separate Playwright workers are separate processes
// with their own copy.

let currentOwner: string | null = null;

export function setWorkerOwner(ownerId: string | null): void {
  currentOwner = ownerId;
}

export function getWorkerOwner(): string | null {
  return currentOwner;
}
