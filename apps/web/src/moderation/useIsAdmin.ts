import { useQuery } from '@tanstack/react-query';
import { supabase } from '../supabase.js';
import { useAuth } from '../auth/AuthProvider.js';

/**
 * Returns `true` if the current user is in the `admins` table.
 * RLS allows users to read their own admins row (the `admins_self_or_admin_read`
 * policy), so a non-admin simply gets an empty result.
 */
export function useIsAdmin(): { isAdmin: boolean; isLoading: boolean } {
  const { user, loading: authLoading } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['is-admin', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admins')
        .select('user_id')
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return !!data;
    },
  });
  return { isAdmin: !!data, isLoading: authLoading || isLoading };
}
