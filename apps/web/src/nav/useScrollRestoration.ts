import { useEffect, useLayoutEffect, useRef } from 'react';
import { NavigationType, useLocation, useNavigationType } from 'react-router-dom';

const STORE_KEY = 'cookyourbooks.scroll.v1';
const MAX_ENTRIES = 50;
const RESTORE_TIMEOUT_MS = 2000;

interface Store {
  order: string[];
  pos: Record<string, number>;
}

function readStore(): Store {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Store;
      if (Array.isArray(parsed.order) && parsed.pos) return parsed;
    }
  } catch {
    /* private mode / corrupt — start fresh */
  }
  return { order: [], pos: {} };
}

function save(key: string, y: number): void {
  try {
    const store = readStore();
    if (!(key in store.pos)) store.order.push(key);
    store.pos[key] = y;
    while (store.order.length > MAX_ENTRIES) {
      const evicted = store.order.shift()!;
      delete store.pos[evicted];
    }
    sessionStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* non-fatal */
  }
}

function read(key: string): number | null {
  const store = readStore();
  return key in store.pos ? store.pos[key]! : null;
}

/**
 * Scroll restoration for the declarative React Router (v7 has no
 * <ScrollRestoration> outside data-router mode): going Back/Forward returns
 * to the position you left; pushing a new route starts at the top.
 *
 * Positions are keyed by `location.key` (unique per history entry, so two
 * visits to the same path restore independently) in sessionStorage, capped
 * FIFO. Because local-first pages render a short "Loading…" first, a POP
 * restore retries on rAF until the document is tall enough to honor the
 * offset (or 2s passes), and aborts the moment the user scrolls themselves.
 */
export function useScrollRestoration(): void {
  const location = useLocation();
  const navType = useNavigationType();

  // The browser's own restoration would fight the rAF loop — take over once.
  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  // Passive tracker: last known scrollY without re-rendering. Also persist
  // the current entry on pagehide so reload / bfcache keeps its position.
  const yRef = useRef(0);
  const keyRef = useRef(location.key);
  keyRef.current = location.key;
  useEffect(() => {
    const onScroll = () => {
      yRef.current = window.scrollY;
    };
    const onPageHide = () => save(keyRef.current, yRef.current);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  const prevKey = useRef(location.key);
  const restoreToken = useRef(0);
  useLayoutEffect(() => {
    // Save the OUTGOING entry's position: yRef still holds the pre-navigation
    // scrollY because the DOM hasn't painted the new route yet.
    if (prevKey.current !== location.key) {
      save(prevKey.current, yRef.current);
      prevKey.current = location.key;
    }
    const token = ++restoreToken.current;

    if (navType === NavigationType.Pop) {
      const y = read(location.key);
      if (y != null && y > 0) {
        restoreWhenReady(y, token, restoreToken);
        return;
      }
    }
    // PUSH → a brand-new page starts at the top. REPLACE keeps the position
    // (it's the same logical page — e.g. a canonical-redirect or tab swap).
    if (navType !== NavigationType.Replace) window.scrollTo(0, 0);
  }, [location.key, navType]);
}

function restoreWhenReady(y: number, token: number, restoreToken: { current: number }): void {
  const start = performance.now();
  const cancel = () => {
    restoreToken.current += 1;
  };
  // The user taking over scrolling outranks us — never yank the page back.
  window.addEventListener('wheel', cancel, { once: true, passive: true });
  window.addEventListener('touchstart', cancel, { once: true, passive: true });

  const tick = () => {
    if (restoreToken.current !== token) return; // superseded nav or user input
    const reachable = document.documentElement.scrollHeight - window.innerHeight >= y;
    if (reachable) {
      window.scrollTo(0, y);
      return;
    }
    if (performance.now() - start > RESTORE_TIMEOUT_MS) {
      window.scrollTo(0, y); // best effort — content never got tall enough
      return;
    }
    requestAnimationFrame(tick);
  };
  window.scrollTo(0, y); // immediate attempt for synchronously-tall pages
  requestAnimationFrame(tick);
}
