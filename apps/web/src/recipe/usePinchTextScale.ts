import { type RefObject, useEffect } from 'react';

function isCapacitorNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

/**
 * Two-finger pinch on the recipe content mapped to the text-size scale —
 * native (Capacitor) only, where page-level pinch zoom fights the fixed
 * layout. On the web this is a no-op so the browser's own pinch zoom keeps
 * working. One-finger vertical scrolling stays native via touch-action:
 * pan-y, which the hook sets on the container while active.
 *
 * Uses touch events (like PinchPanImage) rather than pointer events: iOS
 * Safari/WKWebView delivers multi-touch more reliably through touchmove.
 */
export function usePinchTextScale(
  ref: RefObject<HTMLElement | null>,
  getScale: () => number,
  setScale: (n: number) => void,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !isCapacitorNative()) return;

    const prevTouchAction = el.style.touchAction;
    el.style.touchAction = 'pan-y';

    let startDist: number | null = null;
    let startScale = 1;

    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        startDist = dist(e.touches[0]!, e.touches[1]!);
        startScale = getScale();
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (startDist == null || e.touches.length !== 2) return;
      e.preventDefault(); // we own two-finger gestures inside the recipe body
      const ratio = dist(e.touches[0]!, e.touches[1]!) / startDist;
      setScale(startScale * ratio);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) startDist = null;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    // passive: false so preventDefault can stop the WebView's own pinch.
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.style.touchAction = prevTouchAction;
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [ref, getScale, setScale]);
}
