import { useEffect, useRef, useState } from 'react';

/**
 * Cycle through `lines` every `rotateMs`, starting at a random line per mount
 * (so repeat visits differ). Under prefers-reduced-motion the rotation stops
 * and the first line is shown statically. Extracted from LoadingOverlay so
 * the inline LoadingState shares the exact behavior.
 */
export function useRotatingLine(
  lines: readonly string[] | undefined,
  rotateMs = 2500,
): string | undefined {
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const [lineIdx, setLineIdx] = useState(0);
  const lineCount = lines?.length ?? 0;
  // Pick a stable random starting line per mount so repeat visits differ.
  const start = useRef(lineCount > 0 ? Math.floor(Math.random() * lineCount) : 0);
  useEffect(() => {
    if (reducedMotion || lineCount <= 1) return;
    const t = setInterval(() => setLineIdx((i) => i + 1), rotateMs);
    return () => clearInterval(t);
  }, [reducedMotion, lineCount, rotateMs]);

  if (lineCount === 0) return undefined;
  if (reducedMotion) return lines![start.current % lineCount];
  return lines![(start.current + lineIdx) % lineCount];
}
