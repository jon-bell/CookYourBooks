import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider.js';
import {
  useCollectionNotes,
  useSaveCollectionNote,
  useDeleteCollectionNote,
} from '../notes/queries.js';
import type { CollectionNoteRecord } from '../local/repositories.js';

/**
 * "General notes" attached to a collection — OCR'd intro/prose pages (marked
 * "Notes" during scanning, auto-filed by the import worker) plus hand-written
 * notes. Owned notes are editable/deletable; a co-member's shared notes are
 * read-only with a badge. Body is plain text with paragraph breaks preserved.
 */
export function CollectionNotesSection({ collectionId }: { collectionId: string }) {
  const { user } = useAuth();
  const { data: notes = [] } = useCollectionNotes(collectionId);
  const save = useSaveCollectionNote(collectionId);
  const remove = useDeleteCollectionNote(collectionId);
  const [adding, setAdding] = useState(false);

  return (
    <section className="space-y-3" aria-label="Collection notes">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Notes</h2>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            + Add note
          </button>
        )}
      </div>

      {adding && (
        <NoteEditor
          submitting={save.isPending}
          onCancel={() => setAdding(false)}
          onSave={async (title, body) => {
            await save.mutateAsync({ collectionId, title, body, sortOrder: notes.length });
            setAdding(false);
          }}
        />
      )}

      {notes.length === 0 && !adding ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">
          No notes yet. Scan an intro page (mark it “Notes” in the camera) or add one by hand.
        </p>
      ) : (
        <ul className="space-y-3">
          {notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              editable={note.ownerId === user?.id}
              onSave={(title, body) =>
                save.mutateAsync({
                  id: note.id,
                  collectionId,
                  title,
                  body,
                  sortOrder: note.sortOrder,
                })
              }
              onDelete={() => remove.mutateAsync(note.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function NoteCard({
  note,
  editable,
  onSave,
  onDelete,
}: {
  note: CollectionNoteRecord;
  editable: boolean;
  onSave: (title: string, body: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li>
        <NoteEditor
          initialTitle={note.title}
          initialBody={note.body}
          onCancel={() => setEditing(false)}
          onSave={async (title, body) => {
            await onSave(title, body);
            setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-700 dark:bg-stone-900">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium text-stone-900 dark:text-stone-100">{note.title}</h3>
        {editable ? (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-sm text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm('Delete this note?')) void onDelete();
              }}
              className="text-sm text-red-600 hover:text-red-700 dark:text-red-400"
            >
              Delete
            </button>
          </div>
        ) : (
          <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800 dark:bg-sky-900 dark:text-sky-200">
            Shared by household
          </span>
        )}
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-stone-700 dark:text-stone-300">
        {note.body}
      </p>
    </li>
  );
}

function NoteEditor({
  initialTitle = '',
  initialBody = '',
  submitting,
  onSave,
  onCancel,
}: {
  initialTitle?: string;
  initialBody?: string;
  submitting?: boolean;
  onSave: (title: string, body: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const canSave = body.trim().length > 0;

  return (
    <div className="space-y-2 rounded-lg border border-stone-300 bg-white p-3 dark:border-stone-700 dark:bg-stone-900">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        aria-label="Note title"
        className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Note text"
        aria-label="Note text"
        rows={5}
        className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSave || submitting}
          onClick={() => onSave(title.trim() || 'Note', body)}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
        >
          Save
        </button>
      </div>
    </div>
  );
}
