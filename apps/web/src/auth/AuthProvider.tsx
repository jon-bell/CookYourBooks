import type { Session, User } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { setSentryUser } from '../sentry.js';
import { supabase } from '../supabase.js';
import { claimsFromSession } from './claims.js';

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  /** `household_id` JWT claim (custom_access_token_hook), or null. */
  householdId: string | null;
  /** `is_admin` JWT claim. */
  isAdmin: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session ?? null);
      setSentryUser(data.session?.user?.id ?? null);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      // Identify the user to Sentry for every subsequent event. UUID
      // only — no email — see sentry.ts:setSentryUser.
      setSentryUser(next?.user?.id ?? null);
    });
    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(() => {
    const { householdId, isAdmin } = claimsFromSession(session);
    return {
      session,
      user: session?.user ?? null,
      loading,
      householdId,
      isAdmin,
      signOut: async () => {
        await supabase.auth.signOut();
      },
    };
  }, [session, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
