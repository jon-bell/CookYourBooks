import { useCallback } from 'react';
import { useAuth } from '../auth/AuthProvider.js';
import { useMyHousehold } from '../household/queries.js';

/**
 * Returns a function mapping an event's owner user-id to a display label.
 * The current user is "You"; household co-members resolve to their
 * display name (falling back to "A household member" when the profile
 * name is missing).
 */
export function useAttribution(): (ownerUserId: string) => string {
  const { user } = useAuth();
  const { data: household } = useMyHousehold();
  const members = household?.members ?? [];
  return useCallback(
    (ownerUserId: string) => {
      if (ownerUserId === user?.id) return 'You';
      const member = members.find((m) => m.user_id === ownerUserId);
      return member?.display_name ?? 'A household member';
    },
    [user?.id, members],
  );
}
