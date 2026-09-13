import { beforeEach, describe, expect, it, vi } from 'vitest';

// The runner is a module singleton (a `started` latch + a progress map), so
// every case re-imports it fresh.
const loadRunner = async () => {
  vi.resetModules();
  return import('./backfill.js');
};

let msSinceRecovery = Number.POSITIVE_INFINITY;
const execO = vi.fn();
const exec = vi.fn();

vi.mock('./db.js', () => ({
  getLocalDb: () => Promise.resolve({ execO, exec }),
  msSinceAutoRecovery: () => msSinceRecovery,
}));
vi.mock('./outbox.js', () => ({ enqueue: vi.fn(() => Promise.resolve()) }));
vi.mock('./ingredientLinks.js', () => ({
  computeAndApplyLinks: vi.fn(() => Promise.resolve(false)),
}));

/** A DB where reading state + counting rows works but the first chunk blows up
 *  — the shape of a lost IndexedDB transaction mid-backfill. */
function failingChunkDb(): void {
  execO.mockImplementation((sql: string) => {
    if (sql.includes('from backfill_state')) return Promise.resolve([]);
    if (sql.includes('from sqlite_master')) return Promise.resolve([{ c: 0 }]);
    if (sql.includes('count(*)')) return Promise.resolve([{ c: 500 }]);
    return Promise.reject(new Error('database connection is not open'));
  });
  exec.mockResolvedValue(undefined);
}

describe('startBackfills', () => {
  beforeEach(() => {
    msSinceRecovery = Number.POSITIVE_INFINITY;
    execO.mockReset();
    exec.mockReset();
  });

  it('leaves nothing in the running state when a chunk throws', async () => {
    failingChunkDb();
    const { startBackfills, backfillActive, getBackfillProgress } = await loadRunner();

    await startBackfills();

    // The blocking schema-upgrade overlay keys off `running`; a failed backfill
    // that stayed there would lock the user out of the app until they reloaded.
    expect(backfillActive()).toBe(false);
    expect(getBackfillProgress().map((p) => p.status)).not.toContain('running');
    expect(getBackfillProgress().some((p) => p.status === 'pending')).toBe(true);
  });

  it('defers entirely when the local DB auto-recovered recently', async () => {
    failingChunkDb();
    msSinceRecovery = 5_000;
    const { startBackfills, backfillActive, getBackfillProgress } = await loadRunner();

    await startBackfills();

    // Restarting the heaviest write load right after a recovery reload is what
    // turns one fault into a reload loop.
    expect(execO).not.toHaveBeenCalled();
    expect(backfillActive()).toBe(false);
    expect(getBackfillProgress()).toEqual([]);
  });

  it('marks an empty DB done without ever showing as running', async () => {
    execO.mockImplementation((sql: string) => {
      if (sql.includes('from backfill_state')) return Promise.resolve([]);
      return Promise.resolve([{ c: 0 }]);
    });
    exec.mockResolvedValue(undefined);
    const { startBackfills, backfillActive, getBackfillProgress } = await loadRunner();

    await startBackfills();

    expect(backfillActive()).toBe(false);
    expect(getBackfillProgress().every((p) => p.status === 'done')).toBe(true);
  });
});
