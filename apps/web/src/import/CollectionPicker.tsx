import { useState } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import { type BookForm, emptyBookForm } from '../books/bookForm.js';
import { BookMetadataFields } from '../books/BookMetadataFields.js';
import { buildCookbookFromForm } from '../books/buildCookbook.js';
import { useSaveCollection } from '../data/queries.js';
import type { CollectionPickerOption } from '../local/repositories.js';
import { CookbookCombobox } from './CookbookCombobox.js';

interface Props {
  options: readonly CollectionPickerOption[];
  /** Currently-selected collection id. Empty string means unassigned. */
  value: string;
  onChange: (id: string) => void;
  loading?: boolean;
  /** Forwarded to the combobox — shows "will update <title>" on the picked row. */
  matchedExistingTitle?: string;
  /** Forwarded to the combobox — label for the empty / value==='' choice. */
  unassignedLabel?: string;
  /** Seed placeholder recipes from a scanned ISBN's table of contents when the
   *  new cookbook is created. Default on — matches the bulk-import wizard. */
  seedToc?: boolean;
}

/**
 * Collection picker with an inline "create a new cookbook" flow. Wraps
 * {@link CookbookCombobox} and, when the user chooses "Create new cookbook…",
 * swaps in the full {@link BookMetadataFields} form (title / author / ISBN scan
 * + catalog / Open Library autofill) so any import surface can mint a cookbook
 * — with ISBN — without leaving for the New Collection page. On save the new
 * cookbook is selected automatically.
 */
export function CollectionPicker({
  options,
  value,
  onChange,
  loading = false,
  matchedExistingTitle,
  unassignedLabel,
  seedToc = true,
}: Props) {
  const { user } = useAuth();
  const saveCollection = useSaveCollection();
  const [creating, setCreating] = useState(false);
  const [newBook, setNewBook] = useState<BookForm>(emptyBookForm);
  const [error, setError] = useState<string | null>(null);

  async function onCreate() {
    if (!newBook.title.trim() || !user) return;
    setError(null);
    try {
      const cookbook = await buildCookbookFromForm(newBook, { userId: user.id, seedToc });
      await saveCollection.mutateAsync(cookbook);
      onChange(cookbook.id);
      setCreating(false);
      setNewBook(emptyBookForm());
    } catch (e) {
      setError(`Could not create cookbook: ${(e as Error).message}`);
    }
  }

  if (creating) {
    return (
      <div className="space-y-3 rounded border border-stone-300 dark:border-stone-600 bg-stone-50 dark:bg-stone-900 p-3">
        <BookMetadataFields value={newBook} onChange={setNewBook} />
        {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={!newBook.title.trim() || saveCollection.isPending}
            className="rounded-md bg-stone-900 px-3 py-1 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
          >
            {saveCollection.isPending ? 'Creating…' : 'Create'}
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setNewBook(emptyBookForm());
              setError(null);
            }}
            className="rounded-md px-3 py-1 text-xs text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <CookbookCombobox
      options={options}
      value={value}
      onChange={onChange}
      onCreateNew={() => setCreating(true)}
      loading={loading}
      matchedExistingTitle={matchedExistingTitle}
      unassignedLabel={unassignedLabel}
    />
  );
}
