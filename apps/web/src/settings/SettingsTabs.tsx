import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

// Settings is split into four focused sub-pages, each its own route. This
// mirrors the Admin area's AdminTabs (admin/RequireAdmin.tsx): a stateless
// tab bar rendered at the top of every settings page, with the active tab
// derived from the current path.

const TABS: readonly { to: string; label: string }[] = [
  { to: '/settings/llm', label: 'LLM & models' },
  { to: '/settings/conversions', label: 'Conversions' },
  { to: '/settings/cli', label: 'CLI tokens' },
  { to: '/settings/danger', label: 'Data & deletion' },
];

/**
 * The four settings tabs are flat siblings (no nested routes), so a tab is
 * active iff the path matches it exactly — simpler than AdminTabs, which has
 * to special-case a tab whose path prefixes a sibling's. Exported pure so the
 * active logic is unit-testable without mounting a router.
 */
export function isSettingsTabActive(pathname: string, to: string): boolean {
  return pathname === to;
}

export function SettingsTabs() {
  return (
    <nav
      aria-label="Settings sections"
      className="flex flex-wrap gap-3 border-b border-stone-200 dark:border-stone-700 text-sm"
    >
      {TABS.map((t) => (
        <SettingsTabLink key={t.to} to={t.to}>
          {t.label}
        </SettingsTabLink>
      ))}
    </nav>
  );
}

function SettingsTabLink({ to, children }: { to: string; children: ReactNode }) {
  const location = useLocation();
  const active = isSettingsTabActive(location.pathname, to);
  return (
    <Link
      to={to}
      className={`-mb-px rounded-t border-b-2 px-3 py-2 ${
        active
          ? 'border-stone-900 dark:border-stone-100 font-medium text-stone-900 dark:text-stone-100'
          : 'border-transparent text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100'
      }`}
    >
      {children}
    </Link>
  );
}

/** Shared chrome for every settings sub-page: the container, the "Settings"
 * heading (an e2e asserts it), and the tab bar. Pages slot their section
 * cards as children. */
export function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <SettingsTabs />
      {children}
    </div>
  );
}
