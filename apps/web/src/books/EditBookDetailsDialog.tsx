import type { Cookbook } from '@cookyourbooks/domain';
import { useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import { useSaveCollection } from '../data/queries.js';
import { type BookForm, bookFormFromCookbook } from './bookForm.js';
import { BookMetadataFields } from './BookMetadataFields.js';
import { buildCookbookFromForm } from './buildCookbook.js';

/**
 * Edit a cookbook's metadata (title / author / ISBN / publisher / year /
 * cover) after creation. Reuses BookMetadataFields, so the same ISBN
 * lookup + cover-scan affordances are available here too. Preserves the
 * cookbook's recipes and public / moderation state via `base`.
 */
export function EditBookDetailsDialog({
  cookbook,
  open,
  onClose,
}: {
  cookbook: Cookbook;
  open: boolean;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const save = useSaveCollection();
  const [form, setForm] = useState<BookForm>(() => bookFormFromCookbook(cookbook));

  // Reset the form to the current cookbook each time the dialog opens.
  useEffect(() => {
    if (open) setForm(bookFormFromCookbook(cookbook));
  }, [open, cookbook]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !form.title.trim()) return;
    const updated = await buildCookbookFromForm(form, { userId: user.id, base: cookbook });
    await save.mutateAsync(updated);
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-book-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={onSubmit}
        className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-lg bg-white dark:bg-stone-900 p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="edit-book-title" className="text-lg font-semibold">
          Edit cookbook details
        </h2>
        <BookMetadataFields value={form} onChange={setForm} />
        {save.isError && (
          <p className="text-sm text-red-700 dark:text-red-300">{save.error.message}</p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!form.title.trim() || save.isPending}
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
