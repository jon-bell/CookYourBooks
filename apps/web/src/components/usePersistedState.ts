import { useCallback, useState } from 'react';

/**
 * useState backed by localStorage, for small string-union preferences like
 * sort modes. The validator guards against stale/garbage stored values (e.g.
 * a sort mode removed in a later release) by falling back to the default.
 * Storage failures (private mode, quota) are non-fatal — the state simply
 * doesn't persist.
 */
export function usePersistedState<T extends string>(
  key: string,
  fallback: T,
  isValid: (v: string) => v is T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null && isValid(stored)) return stored;
    } catch {
      /* private mode — use the fallback */
    }
    return fallback;
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        /* non-fatal — preference just won't survive the session */
      }
    },
    [key],
  );

  return [value, set];
}
