import { Link, useLocation } from 'react-router-dom';
import { useIsAdmin } from '../moderation/useIsAdmin.js';

/**
 * Gates an admin-only route. We render an explicit "restricted" message
 * rather than 404'ing so the URL stays debuggable — the `admins` table is
 * the single source of truth, and a wrong answer here should not look
 * like a routing bug.
 */
export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { isAdmin, isLoading } = useIsAdmin();
  const location = useLocation();
  if (isLoading) return <p className="text-stone-500">Loading…</p>;
  if (!isAdmin) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-stone-600">
          This surface is restricted to administrators. If you think you should have access,
          ask another admin to grant it.
        </p>
        <p className="text-xs text-stone-500">Path: <code>{location.pathname}</code></p>
      </div>
    );
  }
  return <>{children}</>;
}

export function AdminTabs() {
  return (
    <nav aria-label="Admin sections" className="flex gap-3 border-b border-stone-200 text-sm">
      <AdminTabLink to="/admin">Moderation</AdminTabLink>
      <AdminTabLink to="/admin/global-toc">Global ToC</AdminTabLink>
    </nav>
  );
}

function AdminTabLink({ to, children }: { to: string; children: React.ReactNode }) {
  const location = useLocation();
  // /admin matches only exactly, /admin/global-toc matches its subroutes too.
  const active =
    to === '/admin'
      ? location.pathname === '/admin'
      : location.pathname === to || location.pathname.startsWith(`${to}/`);
  return (
    <Link
      to={to}
      className={`-mb-px rounded-t border-b-2 px-3 py-2 ${
        active
          ? 'border-stone-900 font-medium text-stone-900'
          : 'border-transparent text-stone-600 hover:text-stone-900'
      }`}
    >
      {children}
    </Link>
  );
}
