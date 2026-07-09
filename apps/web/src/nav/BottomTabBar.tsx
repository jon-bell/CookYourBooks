import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { SAFE_X } from '../components/mobileSafeArea.js';
import { useMobileNav } from './MobileNav.js';

/**
 * Native-style bottom tab bar for the sub-`md` (phone) layout. The header
 * scrolls with the page, so this is the always-visible primary nav — the top
 * handful of `PRIMARY_NAV` destinations plus a "More" button that opens the
 * full {@link MobileNav} sheet (account nav, admin, theme, sign-out).
 *
 * `fixed` at the bottom above the home indicator; `<main>` carries matching
 * bottom padding (App.tsx) so content never hides behind it.
 */
interface Tab {
  label: string;
  to: string;
  icon: ReactNode;
}

const ICON = 'h-6 w-6';

const TABS: readonly Tab[] = [
  {
    label: 'Recipes',
    to: '/',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className={ICON}
        aria-hidden="true"
      >
        <path d="M4 5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v14a1 1 0 0 1-1.4.9L11 18l-4.6 1.9A1 1 0 0 1 5 19V5Z" />
        <path d="M9 3v14" />
      </svg>
    ),
  },
  {
    label: 'Library',
    to: '/library',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        className={ICON}
        aria-hidden="true"
      >
        <path d="M5 4v16M9 4v16" />
        <path d="M13 5l4-1 3 15-4 1L13 5Z" />
      </svg>
    ),
  },
  {
    label: 'Search',
    to: '/search',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        className={ICON}
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    ),
  },
  {
    label: 'Import',
    to: '/import',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={ICON}
        aria-hidden="true"
      >
        <path d="M3 8a2 2 0 0 1 2-2h1.5l1-1.5h5l1 1.5H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H3.8" />
        <circle cx="12.5" cy="12" r="3.2" />
      </svg>
    ),
  },
];

function isActive(pathname: string, to: string): boolean {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);
}

function tabClass(active: boolean): string {
  return [
    'flex min-h-[52px] flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] font-medium',
    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-stone-500',
    active
      ? 'text-stone-900 dark:text-stone-100'
      : 'text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200',
  ].join(' ');
}

export function BottomTabBar() {
  const location = useLocation();
  const { open, setOpen } = useMobileNav();

  // Hide on focused/immersive flows that own the bottom of the screen — every
  // import sub-flow has its own sticky action bar (the organizer's "Start OCR",
  // the batch queue footer) and cook mode is full-screen. Otherwise the fixed
  // bar would sit on top of those controls.
  if (/^\/import\/.+/.test(location.pathname) || /\/cook$/.test(location.pathname)) {
    return null;
  }

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-stone-200 bg-white/95 backdrop-blur dark:border-stone-700 dark:bg-stone-900/95 md:hidden"
    >
      <ul className={`grid grid-cols-5 pb-[env(safe-area-inset-bottom)] ${SAFE_X}`}>
        {TABS.map((t) => {
          const active = isActive(location.pathname, t.to);
          return (
            <li key={t.to} className="flex">
              <Link
                to={t.to}
                aria-current={active ? 'page' : undefined}
                onClick={() => window.scrollTo({ top: 0 })}
                className={`w-full ${tabClass(active)}`}
              >
                {t.icon}
                <span>{t.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="flex">
          <button
            type="button"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls="mobile-nav-sheet"
            onClick={() => setOpen(true)}
            className={`w-full ${tabClass(false)}`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              className={ICON}
              aria-hidden="true"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            <span>More</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
