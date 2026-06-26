import { Navigate, useLocation } from 'react-router-dom';

import { LoadingState } from '../components/LoadingState.js';
import { useAuth } from './AuthProvider.js';

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingState surface="auth" />;
  if (!user) {
    return <Navigate to="/sign-in" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}
