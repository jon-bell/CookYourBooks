import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider.js';
import { useSync } from '../local/SyncProvider.js';
import * as api from './api.js';
import {
  getHouseholdOcrConfig,
  setHouseholdOcrConfig,
  listOcrKeys,
} from '../import/api.js';

/** Active household + members + role for the signed-in user. */
export function useMyHousehold(): UseQueryResult<
  Awaited<ReturnType<typeof api.getMyHousehold>>
> {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['household', 'mine', user?.id],
    queryFn: api.getMyHousehold,
    enabled: !!user,
  });
}

export function useHouseholdInvites(householdId: string | undefined) {
  return useQuery({
    queryKey: ['household', 'invites', householdId],
    queryFn: () => (householdId ? api.listMyHouseholdInvites(householdId) : Promise.resolve([])),
    enabled: !!householdId,
  });
}

export function useMyCooldown() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['household', 'cooldown', user?.id],
    queryFn: api.getMyCooldown,
    enabled: !!user,
  });
}

export function useTosVersion() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['tos', 'version', user?.id],
    queryFn: api.getMyTosVersion,
    enabled: !!user,
  });
}

export function useAuditLog() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['audit', 'mine', user?.id],
    queryFn: () => api.listMyAuditLog({ limit: 200 }),
    enabled: !!user,
  });
}

// ---------- Mutations ----------
//
// Each mutation invalidates the household queries and triggers a sync
// cycle so the local SQLite cache reflects new shares / membership
// changes immediately.

function useInvalidateHousehold() {
  const qc = useQueryClient();
  const { syncNow } = useSync();
  return async () => {
    await qc.invalidateQueries({ queryKey: ['household'] });
    await qc.invalidateQueries({ queryKey: ['audit'] });
    await syncNow();
  };
}

export function useCreateHousehold() {
  const invalidate = useInvalidateHousehold();
  return useMutation({
    mutationFn: api.createHousehold,
    onSuccess: invalidate,
  });
}

export function useInviteToHousehold() {
  const invalidate = useInvalidateHousehold();
  return useMutation({
    mutationFn: api.inviteToHousehold,
    onSuccess: invalidate,
  });
}

export function useRevokeHouseholdInvite() {
  const invalidate = useInvalidateHousehold();
  return useMutation({
    mutationFn: api.revokeHouseholdInvite,
    onSuccess: invalidate,
  });
}

export function useAcceptHouseholdInvite() {
  const invalidate = useInvalidateHousehold();
  return useMutation({
    mutationFn: api.acceptHouseholdInvite,
    onSuccess: invalidate,
  });
}

export function useLeaveHousehold() {
  const invalidate = useInvalidateHousehold();
  return useMutation({
    mutationFn: api.leaveHousehold,
    onSuccess: invalidate,
  });
}

export function useRemoveHouseholdMember() {
  const invalidate = useInvalidateHousehold();
  return useMutation({
    mutationFn: api.removeHouseholdMember,
    onSuccess: invalidate,
  });
}

export function useTransferHouseholdOwnership() {
  const invalidate = useInvalidateHousehold();
  return useMutation({
    mutationFn: api.transferHouseholdOwnership,
    onSuccess: invalidate,
  });
}

export function useRenameHousehold() {
  const invalidate = useInvalidateHousehold();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameHousehold(id, name),
    onSuccess: invalidate,
  });
}

export function useDeleteHousehold() {
  const invalidate = useInvalidateHousehold();
  return useMutation({
    mutationFn: api.deleteHousehold,
    onSuccess: invalidate,
  });
}

export function useSetLibrarySharing() {
  const invalidate = useInvalidateHousehold();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      householdId,
      enabled,
      attestation,
    }: {
      householdId: string;
      enabled: boolean;
      attestation?: string;
    }) => api.setLibrarySharing(householdId, enabled, attestation),
    onSuccess: async () => {
      await invalidate();
      await qc.invalidateQueries({ queryKey: ['collections'] });
    },
  });
}

export function useHouseholdOcrConfig() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['household', 'ocr', user?.id],
    queryFn: getHouseholdOcrConfig,
    enabled: !!user,
  });
}

/** The caller's own OCR keys — used by the owner to pick which to share. */
export function useOwnOcrKeys() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['ocr', 'keys', user?.id],
    queryFn: listOcrKeys,
    enabled: !!user,
  });
}

export function useSetHouseholdOcrConfig() {
  const invalidate = useInvalidateHousehold();
  return useMutation({
    mutationFn: setHouseholdOcrConfig,
    onSuccess: invalidate,
  });
}

export function useAttestPublicShare() {
  return useMutation({
    mutationFn: ({ collectionId, attestation }: { collectionId: string; attestation: string }) =>
      api.attestPublicShare(collectionId, attestation),
  });
}

export function useAcceptTos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.acceptTos,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tos'] });
      await qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}
