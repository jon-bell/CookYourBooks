import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createCookbook,
  createPersonalCollection,
  createWebCollection,
  type RecipeCollection,
} from '@cookyourbooks/domain';
import { useSaveCollection } from '../data/queries.js';

type Kind = 'PERSONAL' | 'PUBLISHED_BOOK' | 'WEBSITE';

export function NewCollectionPage() {
  const navigate = useNavigate();
  const save = useSaveCollection();
  const [kind, setKind] = useState<Kind>('PERSONAL');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    let c: RecipeCollection;
    if (kind === 'PUBLISHED_BOOK') c = createCookbook({ title, author: author || undefined });
    else if (kind === 'WEBSITE')
      c = createWebCollection({ title, sourceUrl: sourceUrl || undefined });
    else c = createPersonalCollection({ title, description: description || undefined });
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
