import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider.js';

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="text-stone-500">Loading…</div>;
  if (!user) {
    return <Navigate to="/sign-in" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}
