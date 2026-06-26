import { Link } from 'react-router-dom';

import { useFileNote, useNoteForImportItem } from '../notes/queries.js';

/**
 * Batch-review surface for a NOTES page. The worker auto-files the note, so
 * this is mostly a confirmation: show the saved prose and link to the cookbook
 * where it lives. For a note from an unassigned batch (collection_id null) it
 * offers a one-tap "file under the selected cookbook".
 */
export function NotesReviewPanel({
  itemId,
  defaultCollectionId,
}: {
  itemId: string;
  defaultCollectionId: string | null;
}) {
  const { data: note, isLoading } = useNoteForImportItem(itemId);
  const file = useFileNote();

  if (isLoading) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading note…</p>;
  }
  if (!note) {
    return (
      <p className="text-sm text-stone-500 dark:text-stone-400">
        This page is marked as a notes page. Once OCR finishes, its text is filed under the
        cookbook’s Notes.
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-stone-200 bg-white p-3 text-sm dark:border-stone-700 dark:bg-stone-900">
      <div>
        <h3 className="font-medium text-stone-900 dark:text-stone-100">{note.title}</h3>
        <p className="mt-1 whitespace-pre-wrap text-stone-700 dark:text-stone-300">{note.body}</p>
      </div>
      {note.collectionId ? (
        <Link
          to={`/collections/${note.collectionId}`}
          className="inline-block font-medium text-indigo-700 hover:underline dark:text-indigo-300"
        >
          View in cookbook notes →
        </Link>
      ) : defaultCollectionId ? (
        <button
          type="button"
          disabled={file.isPending}
          onClick={() => void file.mutateAsync({ note, collectionId: defaultCollectionId })}
          className="rounded-md bg-stone-900 px-3 py-1.5 font-medium text-white hover:bg-stone-800 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
        >
          File under the selected cookbook
        </button>
      ) : (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Pick a cookbook above to file this note.
        </p>
      )}
    </div>
  );
}
