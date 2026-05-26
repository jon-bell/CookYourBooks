import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider.js';
import { useLocalQueryEnabled, useSync } from '../local/SyncProvider.js';
import { listOcrKeys, type OcrKeySummary } from './api.js';
import {
  LocalImportBatchRepository,
  LocalImportItemRepository,
} from './localRepos.js';
import type {
  ImportBatch,
  ImportItem,
  ImportItemAttempt,
  ImportTocEntry,
} from './model.js';

export function useImportBatches() {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<ImportBatch[]>({
    queryKey: ['import-batches', user?.id],
    enabled,
    queryFn: () => new LocalImportBatchRepository(user!.id).list(),
  });
}

export function useImportBatch(batchId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<ImportBatch | undefined>({
    queryKey: ['import-batch', batchId],
    enabled: enabled && !!batchId,
    queryFn: () => new LocalImportBatchRepository(user!.id).get(batchId!),
  });
}

export function useImportItems(batchId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<ImportItem[]>({
    queryKey: ['import-items', batchId],
    enabled: enabled && !!batchId,
    queryFn: () => new LocalImportItemRepository(user!.id).listByBatch(batchId!),
  });
}

export function useImportItemsForRecipe(recipeId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<ImportItem[]>({
    queryKey: ['import-items-for-recipe', recipeId, user?.id],
    enabled: enabled && !!recipeId,
    queryFn: () =>
      new LocalImportItemRepository(user!.id).listByCreatedRecipeId(recipeId!),
  });
}

export function useImportItem(itemId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<ImportItem | undefined>({
    queryKey: ['import-item', itemId],
    enabled: enabled && !!itemId,
    queryFn: () => new LocalImportItemRepository(user!.id).get(itemId!),
  });
}

export function useImportItemAttempts(itemId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<ImportItemAttempt[]>({
    queryKey: ['import-item-attempts', itemId],
    enabled: enabled && !!itemId,
    queryFn: () =>
      new LocalImportItemRepository(user!.id).listAttempts(itemId!),
  });
}

export function useImportTocEntries(batchId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<ImportTocEntry[]>({
    queryKey: ['import-toc', batchId],
    enabled: enabled && !!batchId,
    queryFn: () =>
      new LocalImportItemRepository(user!.id).listTocEntries(batchId!),
  });
}

export function useUpdateImportBatch() {
  const { user } = useAuth();
  const { syncNow } = useSync();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      id: string;
      patch: Parameters<LocalImportBatchRepository['update']>[1];
    }) => new LocalImportBatchRepository(user!.id).update(args.id, args.patch),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['import-batches', user?.id] });
      qc.invalidateQueries({ queryKey: ['import-batch', vars.id] });
      void syncNow();
    },
  });
}

export function useUpdateImportItem() {
  const { user } = useAuth();
  const { syncNow } = useSync();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      id: string;
      patch: Parameters<LocalImportItemRepository['update']>[1];
    }) => new LocalImportItemRepository(user!.id).update(args.id, args.patch),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['import-items'] });
      qc.invalidateQueries({ queryKey: ['import-item', vars.id] });
      void syncNow();
    },
  });
}

export function useOcrKeys() {
  const { user } = useAuth();
  return useQuery<OcrKeySummary[]>({
    queryKey: ['ocr-keys', user?.id],
    enabled: !!user,
    queryFn: () => listOcrKeys(),
  });
}
