import { useEffect } from 'react';

// Module-level count so nested/stacked overlays (e.g. the sync diagnostics
// dialog opened from the mobile nav sheet) don't unlock the body when the
// inner one closes.
let lockCount = 0;
let savedScrollY = 0;

/**
 * Lock body scrolling while `active` — for `fixed inset-0` overlays, whose
 * backdrop otherwise lets touch-drag scroll the page underneath on iOS
 * (`overflow: hidden` alone is ignored for touch scrolling in WKWebView, so
 * this uses the position:fixed technique: pin the body at the current scroll
 * offset, then restore the offset on unlock).
 *
 * Call unconditionally (it's a hook) with the overlay's open state; safe to
 * stack — the body unlocks when the last locker deactivates.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    lockCount += 1;
    if (lockCount === 1) {
      savedScrollY = window.scrollY;
      const { style } = document.body;
      style.position = 'fixed';
      style.top = `-${savedScrollY}px`;
      style.left = '0';
      style.right = '0';
      style.overflow = 'hidden';
    }
    return () => {
      lockCount -= 1;
      if (lockCount === 0) {
        const { style } = document.body;
        style.position = '';
        style.top = '';
        style.left = '';
        style.right = '';
        style.overflow = '';
        window.scrollTo(0, savedScrollY);
      }
    };
  }, [active]);
}
