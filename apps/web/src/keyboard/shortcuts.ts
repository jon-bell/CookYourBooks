import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// Keyboard shortcut map.
// - Single-key entries fire on that keypress outside of input fields.
// - Two-key "chord" entries (prefix 'g') require pressing `g` first, then the
//   follow-up within 1.5s. Matches the Gmail / GitHub style.
export interface Shortcut {
  keys: string; // e.g. "/", "n", "e", "g l"
  description: string;
  /** Return true if this shortcut should be considered for the current page. */
  when?: (path: string) => boolean;
  run: (ctx: ShortcutContext) => void;
}

export interface ShortcutContext {
  navigate: ReturnType<typeof useNavigate>;
  pathname: string;
}

const CHORD_WINDOW_MS = 1500;

function isTypingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Registers global keyboard shortcuts. Returns `showHelp` state + setters
 * so a consumer can render a `?` help overlay.
 */
export function useKeyboardShortcuts(shortcuts: readonly Shortcut[]): {
  showHelp: boolean;
  closeHelp: () => void;
} {
  const navigate = useNavigate();
  const location = useLocation();
  const [showHelp, setShowHelp] = useState(false);
  const chordPrefixRef = useRef<{ key: string; at: number } | null>(null);
  // Keep stable refs so the effect doesn't re-bind on every render.
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        setShowHelp(false);
        chordPrefixRef.current = null;
        return;
      }
      if (isTypingInField(e.target)) return;
      if (e.key === '?') {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }

      const now = performance.now();
      const prefix = chordPrefixRef.current;
      const expired = prefix && now - prefix.at > CHORD_WINDOW_MS;
      if (expired) chordPrefixRef.current = null;

      const pathname = pathRef.current;
      const ctx: ShortcutContext = { navigate: navRef.current, pathname };

      for (const sc of shortcutsRef.current) {
        if (sc.when && !sc.when(pathname)) continue;
        if (sc.keys.includes(' ')) {
          const [prefixKey, followKey] = sc.keys.split(' ');
          if (prefix && !expired && prefix.key === prefixKey && e.key === followKey) {
            e.preventDefault();
            chordPrefixRef.current = null;
            sc.run(ctx);
            return;
          }
        } else if (e.key === sc.keys) {
          e.preventDefault();
          sc.run(ctx);
          return;
        }
      }

      // Unmatched single-key entry that could be a chord prefix — remember it.
      if (e.key === 'g') chordPrefixRef.current = { key: 'g', at: now };
      else chordPrefixRef.current = null;
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return { showHelp, closeHelp: () => setShowHelp(false) };
}

export const APP_SHORTCUTS: Shortcut[] = [
  {
    keys: '/',
    description: 'Focus search',
    run: ({ navigate, pathname }) => {
      if (pathname !== '/search') navigate('/search');
      // Defer focus until the page mounts.
      setTimeout(() => {
        const el = document.querySelector<HTMLInputElement>(
          'input[placeholder^="Search by recipe"]',
        );
        el?.focus();
      }, 50);
    },
  },
  {
    keys: 'g l',
    description: 'Go to Library',
    run: ({ navigate }) => navigate('/'),
  },
  {
    keys: 'g d',
    description: 'Go to Discover',
    run: ({ navigate }) => navigate('/discover'),
  },
  {
    keys: 'g s',
    description: 'Go to Shopping list',
    run: ({ navigate }) => navigate('/shopping'),
  },
  {
    keys: 'n',
    description: 'New recipe (in current collection)',
    when: (p) => /^\/collections\/[^/]+$/.test(p),
    run: ({ navigate, pathname }) => navigate(`${pathname}/recipes/new`),
  },
  {
    keys: 'e',
    description: 'Edit this recipe',
    when: (p) => /^\/collections\/[^/]+\/recipes\/[^/]+$/.test(p),
    run: ({ navigate, pathname }) => navigate(`${pathname}/edit`),
  },
  {
    keys: 'c',
    description: 'Cook mode',
    when: (p) => /^\/collections\/[^/]+\/recipes\/[^/]+$/.test(p),
    run: ({ navigate, pathname }) => navigate(`${pathname}/cook`),
  },
];
