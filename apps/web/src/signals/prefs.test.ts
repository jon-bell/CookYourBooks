import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { primeSignalsPref, signalsEnabled } from './prefs.js';

// The unit suite runs under plain Node (no jsdom), so `localStorage` has to be
// stood up by hand — which is also the honest shape of the environments this
// has to survive (locked-down webviews throw on access).
function installLocalStorage(seed?: Record<string, string>): void {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
}

function installThrowingLocalStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    },
  });
}

beforeEach(() => {
  // Clear the module cache so each case exercises the seeding path.
  primeSignalsPref(undefined);
});

afterEach(() => {
  primeSignalsPref(undefined);
});

const MIRROR_KEY = 'cookyourbooks.signals.enabled.v1';

describe('signalsEnabled', () => {
  it('defaults to on when nothing is known yet', () => {
    installLocalStorage();
    // The account setting defaults to true and the server enforces the real
    // value, so guessing "on" before the profile resolves costs at most a
    // wasted request — never a recorded event the user opted out of.
    expect(signalsEnabled()).toBe(true);
  });

  it('seeds from the localStorage mirror so a page load starts correct', () => {
    installLocalStorage({ [MIRROR_KEY]: '0' });
    expect(signalsEnabled()).toBe(false);
  });

  it('reads the mirror once and then serves the cache', () => {
    installLocalStorage({ [MIRROR_KEY]: '0' });
    expect(signalsEnabled()).toBe(false);
    // Mirror wiped underneath us — the cached answer stands.
    installLocalStorage();
    expect(signalsEnabled()).toBe(false);
  });

  it('falls back to the default when localStorage throws', () => {
    installThrowingLocalStorage();
    expect(signalsEnabled()).toBe(true);
  });

  it('honours an explicitly primed value over the mirror', () => {
    installLocalStorage({ [MIRROR_KEY]: '1' });
    primeSignalsPref(false);
    expect(signalsEnabled()).toBe(false);
  });
});
