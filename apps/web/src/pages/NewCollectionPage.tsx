import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  createCookbook,
  createPersonalCollection,
  createRecipe,
  createWebCollection,
  type RecipeCollection,
} from '@cookyourbooks/domain';
import { useSaveCollection } from '../data/queries.js';
import {
  findCookbookByIsbn,
  type GlobalCookbookWithEntries,
} from '../data/globalCookbookLookup.js';
import { CoverImage } from '../components/CoverImage.js';
import { normalizeIsbn } from '../admin/globalToc/openLibrary.js';

type Kind = 'PERSONAL' | 'PUBLISHED_BOOK' | 'WEBSITE';

export function NewCollectionPage() {
  const navigate = useNavigate();
  const save = useSaveCollection();
  const [kind, setKind] = useState<Kind>('PERSONAL');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [isbn, setIsbn] = useState('');
  const [description, setDescription] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [seedFromGlobal, setSeedFromGlobal] = useState(true);

  const lookup = useGlobalLookup(kind === 'PUBLISHED_BOOK' ? isbn : '');

  // When a match comes back, autofill empty title/author so the user
  // doesn't have to retype what we already know. We deliberately don't
  // overwrite fields the user already populated.
  useEffect(() => {
    if (!lookup.match) return;
    setTitle((t) => (t.trim() ? t : lookup.match!.title));
    setAuthor((a) => (a.trim() || !lookup.match!.author ? a : lookup.match!.author!));
  }, [lookup.match]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    let c: RecipeCollection;
    if (kind === 'PUBLISHED_BOOK') {
      c = createCookbook({
        title,
        author: author || lookup.match?.author || undefined,
        isbn: isbn ? (normalizeIsbn(isbn) ?? isbn) : undefined,
        publisher: lookup.match?.publisher ?? undefined,
        publicationYear: lookup.match?.publication_year ?? undefined,
        coverImagePath: lookup.match?.cover_image_path ?? undefined,
        recipes:
          seedFromGlobal && lookup.match
            ? lookup.match.entries.map((entry) =>
                createRecipe({
                  title: entry.title,
                  pageNumbers:
                    typeof entry.page_number === 'number' ? [entry.page_number] : undefined,
                }),
              )
            : undefined,
      });
    } else if (kind === 'WEBSITE') {
      c = createWebCollection({ title, sourceUrl: sourceUrl || undefined });
    } else {
      c = createPersonalCollection({ title, description: description || undefined });
    }
    await save.mutateAsync(c);
    navigate(`/collections/${c.id}`);
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-xl space-y-5">
      <h1 className="text-2xl font-semibold">New collection</h1>
      <Field label="Type">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2"
        >
          <option value="PERSONAL">Personal</option>
          <option value="PUBLISHED_BOOK">Cookbook</option>
          <option value="WEBSITE">Web collection</option>
        </select>
      </Field>
      {kind === 'PUBLISHED_BOOK' && (
        <Field label="ISBN">
          <input
            value={isbn}
            onChange={(e) => setIsbn(e.target.value)}
            placeholder="ISBN-10 or ISBN-13 (optional)"
            className="w-full rounded border border-stone-300 px-3 py-2 font-mono"
          />
          <GlobalCookbookHint lookup={lookup} />
        </Field>
      )}
      <Field label="Title">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2"
        />
      </Field>
      {kind === 'PUBLISHED_BOOK' && (
        <Field label="Author">
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2"
          />
        </Field>
      )}
      {kind === 'PUBLISHED_BOOK' && lookup.match && lookup.match.entries.length > 0 && (
        <label className="flex items-start gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            checked={seedFromGlobal}
            onChange={(e) => setSeedFromGlobal(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Seed {lookup.match.entries.length} placeholder{' '}
            {lookup.match.entries.length === 1 ? 'recipe' : 'recipes'} from this cookbook's table
            of contents
          </span>
        </label>
      )}
      {kind === 'WEBSITE' && (
        <Field label="Source URL">
          <input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2"
            placeholder="https://…"
          />
        </Field>
      )}
      {kind === 'PERSONAL' && (
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2"
          />
        </Field>
      )}
      {save.isError && (
        <div className="rounded border border-red-200 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {(save.error as Error).message}
        </div>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
        >
          {save.isPending ? 'Creating…' : 'Create'}
        </button>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-md px-4 py-2 text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-300">{label}</span>
      {children}
    </label>
  );
}

interface LookupState {
  match: GlobalCookbookWithEntries | null;
  isLoading: boolean;
  triedIsbn: string | null;
}

function useGlobalLookup(rawIsbn: string): LookupState {
  // Only fire when the input normalizes to a plausible ISBN — saves us
  // hitting the DB on every keystroke while the user is still typing.
  const isbn = rawIsbn ? normalizeIsbn(rawIsbn) : null;
  const { data, isLoading } = useQuery({
    queryKey: ['global-cookbook-by-isbn', isbn],
    enabled: !!isbn,
    staleTime: 60_000,
    queryFn: () => findCookbookByIsbn(isbn!),
  });
  return {
    match: data ?? null,
    isLoading,
    triedIsbn: isbn,
  };
}

function GlobalCookbookHint({ lookup }: { lookup: LookupState }) {
  if (!lookup.triedIsbn) return null;
  if (lookup.isLoading) {
    return <p className="mt-2 text-xs text-stone-500">Checking known cookbooks…</p>;
  }
  if (!lookup.match) {
    return (
      <p className="mt-2 text-xs text-stone-500">
        No match in the known-cookbook catalog. You'll fill in the rest by hand.
      </p>
    );
  }
  return (
    <div className="mt-2 flex gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3">
      <CoverImage
        path={lookup.match.cover_image_path ?? undefined}
        className="h-14 w-10 flex-shrink-0 rounded"
        alt={`${lookup.match.title} cover`}
      />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-medium text-emerald-900">{lookup.match.title}</div>
        <div className="truncate text-emerald-800">
          {lookup.match.author ?? 'Unknown author'}
          {lookup.match.publication_year && <> · {lookup.match.publication_year}</>}
        </div>
        <div className="text-xs text-emerald-700">
          {lookup.match.entries.length} known{' '}
          {lookup.match.entries.length === 1 ? 'recipe' : 'recipes'} in the catalog
        </div>
      </div>
    </div>
  );
}
