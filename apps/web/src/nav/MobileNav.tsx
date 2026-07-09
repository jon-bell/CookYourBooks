import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider.js';
import { SAFE_TOP } from '../components/mobileSafeArea.js';
import { useIsAdmin } from '../moderation/useIsAdmin.js';
import { ThemePicker } from '../theme/ThemePicker.js';
import { ACCOUNT_NAV, ADMIN_NAV, PRIMARY_NAV } from './navItems.js';

const LINK_CLASS =
  'block rounded-md px-2 py-3 text-base text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500';

interface MobileNavCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
}

const Ctx = createContext<MobileNavCtx | null>(null);

/**
 * Shared state for the sub-`md` navigation sheet so BOTH entry points — the
 * header hamburger ({@link MobileNav}) and the bottom tab bar's "More" button —
 * open the one sheet. The provider renders the single {@link MobileNavSheet}.
 */
export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Ctx.Provider value={{ open, setOpen }}>
      {children}
      <MobileNavSheet open={open} setOpen={setOpen} />
    </Ctx.Provider>
  );
}

export function useMobileNav(): MobileNavCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMobileNav must be used within MobileNavProvider');
  return v;
}

/**
 * The header hamburger (sub-`md`). Below the `md` breakpoint the desktop inline
 * nav + account menu are hidden (see App.tsx); this and the bottom tab bar are
 * the ways to reach every route.
 */
export function MobileNav() {
  const { open, setOpen } = useMobileNav();
  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label="Open menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="mobile-nav-sheet"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-stone-300 dark:border-stone-600 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
    </div>
  );
}

/**
 * The full-width top sheet. Closes on Escape, on a backdrop tap, on any link
 * tap, and on route change. Focus moves into the sheet on open and back to the
 * previously-focused element (the hamburger or the "More" tab) on close.
 */
function MobileNavSheet({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const { user, signOut } = useAuth();
  const { isAdmin } = useIsAdmin();
  const location = useLocation();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Any route change dismisses the sheet (covers link taps + keyboard chords).
  useEffect(() => {
    setOpen(false);
  }, [location.pathname, setOpen]);

  // Focus into the sheet on open; restore focus to the opener on close.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-stone-900/40" onClick={() => setOpen(false)}>
      <nav
        id="mobile-nav-sheet"
        aria-label="Mobile"
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 top-0 max-h-[90dvh] overflow-y-auto border-b border-stone-200 bg-white px-4 pb-4 shadow-lg dark:border-stone-700 dark:bg-stone-900 ${SAFE_TOP}`}
      >
        <div className="flex items-center justify-between py-2">
          <span className="text-lg font-semibold tracking-tight">CookYourBooks</span>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
          >
            <span aria-hidden>✕</span>
          </button>
        </div>

        <ul className="flex flex-col">
          {PRIMARY_NAV.map((item) => (
            <li key={item.to}>
              <Link to={item.to} onClick={() => setOpen(false)} className={LINK_CLASS}>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="my-2 border-t border-stone-200 dark:border-stone-700" />

        {user ? (
          <ul className="flex flex-col">
            {isAdmin && (
              <li>
                <Link
                  to={ADMIN_NAV.to}
                  onClick={() => setOpen(false)}
                  className="block rounded-md px-2 py-3 text-base text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
                >
                  {ADMIN_NAV.label}
                </Link>
              </li>
            )}
            {ACCOUNT_NAV.map((item) => (
              <li key={item.to}>
                <Link to={item.to} onClick={() => setOpen(false)} className={LINK_CLASS}>
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  void signOut();
                }}
                className={`w-full text-left ${LINK_CLASS}`}
              >
                Sign out
              </button>
            </li>
          </ul>
        ) : (
          <Link to="/sign-in" onClick={() => setOpen(false)} className={LINK_CLASS}>
            Sign in
          </Link>
        )}

        <div className="mt-3 flex items-center gap-2 px-2">
          <span className="text-sm text-stone-500 dark:text-stone-400">Theme</span>
          <ThemePicker />
        </div>
      </nav>
    </div>
  );
}
