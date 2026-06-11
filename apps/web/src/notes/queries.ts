import { type CollectionNote, createCollectionNote } from '@cookyourbooks/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../auth/AuthProvider.js';
import { collectionNoteRepo } from '../data/repos.js';
import type { CollectionNoteRecord } from '../local/repositories.js';
import { useLocalQueryEnabled, useSync } from '../local/SyncProvider.js';

export function useCollectionNotes(collectionId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<CollectionNoteRecord[]>({
    queryKey: ['collection-notes', collectionId],
    enabled: enabled && !!collectionId,
    queryFn: () => collectionNoteRepo(user!.id).listForCollection(collectionId!),
  });
}

function useInvalidateNotes(collectionId: string | undefined) {
  const qc = useQueryClient();
  const { syncNow } = useSync();
  return () => {
    qc.invalidateQueries({ queryKey: ['collection-notes', collectionId] });
    void syncNow();
  };
}

export interface SaveNoteInput {
  /** Omit for a new note; pass the existing id to edit in place. */
  id?: string;
  collectionId: string;
  title: string;
  body: string;
  sortOrder?: number;
}

export function useSaveCollectionNote(collectionId: string | undefined) {
  const { user } = useAuth();
  const invalidate = useInvalidateNotes(collectionId);
  return useMutation({
    mutationFn: (input: SaveNoteInput) =>
      collectionNoteRepo(user!.id).save(
        createCollectionNote({
          id: input.id,
          collectionId: input.collectionId,
          title: input.title,
          body: input.body,
          sortOrder: input.sortOrder ?? 0,
        }),
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteCollectionNote(collectionId: string | undefined) {
  const { user } = useAuth();
  const invalidate = useInvalidateNotes(collectionId);
  return useMutation({
    mutationFn: (id: string) => collectionNoteRepo(user!.id).delete(id),
    onSuccess: invalidate,
  });
}

/** The note auto-filed from one import page (for the batch review surface). */
export function useNoteForImportItem(importItemId: string | undefined) {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<CollectionNoteRecord | undefined>({
    queryKey: ['collection-note-by-item', importItemId],
    enabled: enabled && !!importItemId,
    queryFn: () => collectionNoteRepo(user!.id).getByImportItemId(importItemId!),
  });
}

/** File an unfiled note (from an unassigned scan batch) under a cookbook. */
export function useFileNote() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { syncNow } = useSync();
  return useMutation({
    mutationFn: ({ note, collectionId }: { note: CollectionNote; collectionId: string }) =>
      collectionNoteRepo(user!.id).save({ ...note, collectionId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection-notes'] });
      qc.invalidateQueries({ queryKey: ['collection-note-by-item'] });
      void syncNow();
    },
  });
}
