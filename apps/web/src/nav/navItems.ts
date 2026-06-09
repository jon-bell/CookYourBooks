// Single source of truth for the app's navigation destinations, so the
// desktop header (App.tsx), the desktop account menu (UserMenu.tsx), and
// the mobile sheet (MobileNav.tsx) all render from one list and can't drift.

export interface NavItem {
  label: string;
  to: string;
}

/** Primary destinations: the inline nav on desktop, the top of the sheet on mobile. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { label: 'Library', to: '/' },
  { label: 'Discover', to: '/discover' },
  { label: 'Search', to: '/search' },
  { label: 'Shopping', to: '/shopping' },
  { label: 'Cooking', to: '/cooking' },
  { label: 'Import', to: '/import' },
];

/** Account destinations: the desktop UserMenu and the mobile sheet. */
export const ACCOUNT_NAV: readonly NavItem[] = [
  { label: 'Household', to: '/household' },
  { label: 'LLM costs', to: '/cost' },
  { label: 'Activity', to: '/activity' },
  { label: 'Settings', to: '/settings' },
];

/** Shown only when the viewer is an admin (styled distinctly). */
export const ADMIN_NAV: NavItem = { label: 'Admin', to: '/admin' };
