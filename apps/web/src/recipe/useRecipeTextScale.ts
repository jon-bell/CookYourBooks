import { useCallback, useState } from 'react';

const STORAGE_KEY = 'cookyourbooks.recipeTextScale.v1';
export const TEXT_SCALE_MIN = 0.85;
export const TEXT_SCALE_MAX = 1.6;
export const TEXT_SCALE_STEP = 0.1;

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, Math.round(n * 100) / 100));
}

function readStored(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return 1;
    return clamp(Number(raw));
  } catch {
    return 1;
  }
}

/**
 * The recipe page's persistent text-size preference, applied as CSS zoom on
 * the recipe content (see RecipeContentGrid). One global preference — if you
 * need bigger type on one recipe you need it on all of them.
 */
export function useRecipeTextScale(): {
  scale: number;
  setScale: (n: number) => void;
  increase: () => void;
  decrease: () => void;
  reset: () => void;
} {
  const [scale, setScaleState] = useState<number>(readStored);

  const setScale = useCallback((n: number) => {
    const v = clamp(n);
    setScaleState(v);
    try {
      localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      /* private mode — preference won't survive the session */
    }
  }, []);

  return {
    scale,
    setScale,
    increase: useCallback(() => setScale(scale + TEXT_SCALE_STEP), [scale, setScale]),
    decrease: useCallback(() => setScale(scale - TEXT_SCALE_STEP), [scale, setScale]),
    reset: useCallback(() => setScale(1), [setScale]),
  };
}
