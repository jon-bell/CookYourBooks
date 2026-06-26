import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider.js';
import { useIsAdmin } from '../moderation/useIsAdmin.js';
import { ACCOUNT_NAV, ADMIN_NAV } from '../nav/navItems.js';

export function UserMenu() {
  const { user, signOut } = useAuth();
  const { isAdmin } = useIsAdmin();
  if (!user) return null;
  const label =
    (user.user_metadata as { display_name?: string } | undefined)?.display_name ??
    user.email ??
    'Signed in';
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-stone-600 dark:text-stone-400">{label}</span>
      {isAdmin && (
        <Link
          to={ADMIN_NAV.to}
          className="rounded-md px-2 py-1 text-amber-800 dark:text-amber-300 hover:bg-amber-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
        >
          {ADMIN_NAV.label}
        </Link>
      )}
      {ACCOUNT_NAV.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="rounded-md px-2 py-1 text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        >
          {item.label}
        </Link>
      ))}
      <button
        onClick={() => signOut()}
        className="rounded-md px-2 py-1 text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
      >
        Sign out
      </button>
    </div>
  );
}
