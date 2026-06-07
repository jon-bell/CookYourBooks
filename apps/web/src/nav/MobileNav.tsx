import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { useIsAdmin } from '../moderation/useIsAdmin.js';
import { ThemePicker } from '../theme/ThemePicker.js';
import { PRIMARY_NAV, ACCOUNT_NAV, ADMIN_NAV } from './navItems.js';
import { SAFE_TOP } from '../components/mobileSafeArea.js';

const LINK_CLASS =
  'block rounded-md px-2 py-3 text-base text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500';

/**
 * The sub-`md` navigation: a hamburger button that opens a full-width top
 * sheet. Below the `md` breakpoint the desktop inline nav + account menu
 * are hidden (see App.tsx), so this is the only way to reach those routes.
 *
 * Built from the app's existing hand-rolled scrim/dialog pattern (no UI
 * library). Closes on Escape, on a backdrop tap, on any link tap, and on
 * route change. Focus moves into the sheet on open and back to the
 * hamburger on close.
 */
export function MobileNav() {
  const { user, signOut } = useAuth();
  const { isAdmin } = useIsAdmin();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Close (and restore focus to the trigger) — used by Escape, the ✕, and
  // the backdrop. Navigation closes via the route-change effect instead, so
  // it doesn't fight the browser moving focus to the new page.
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Any route change dismisses the sheet (covers link taps + keyboard chords).
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  return (
    <div className="md:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="mobile-nav-sheet"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-stone-300 dark:border-stone-600 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-stone-900/40"
          onClick={close}
        >
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
                onClick={close}
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
      )}
    </div>
  );
}
