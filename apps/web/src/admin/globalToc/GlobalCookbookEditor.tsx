import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CoverImage } from '../../components/CoverImage.js';
import {
  fetchFromOpenLibrary,
  getCookbook,
  listTocEntries,
  replaceTocEntries,
  updateCookbook,
  uploadCoverFile,
  type GlobalCookbook,
  type GlobalTocEntry,
  type TocEntryDraft,
} from './api.js';
import { normalizeIsbn } from './openLibrary.js';
import { LoadingState } from '../../components/LoadingState.js';

interface FormState {
  isbn: string;
  title: string;
  author: string;
  publisher: string;
  publication_year: string;
  cover_image_path: string;
  notes: string;
}

function toForm(c: GlobalCookbook): FormState {
  return {
    isbn: c.isbn ?? '',
    title: c.title,
    author: c.author ?? '',
    publisher: c.publisher ?? '',
    publication_year: c.publication_year?.toString() ?? '',
    cover_image_path: c.cover_image_path ?? '',
    notes: c.notes ?? '',
  };
}

export function GlobalCookbookEditor() {
  const { cookbookId } = useParams<{ cookbookId: string }>();
  const qc = useQueryClient();

  const { data: cookbook, isLoading, error } = useQuery({
    queryKey: ['global-cookbook', cookbookId],
    queryFn: () => getCookbook(cookbookId!),
    enabled: !!cookbookId,
  });

  if (isLoading) return <LoadingState surface="admin-toc-editor" />;
  if (error) return <p className="text-red-700">{(error as Error).message}</p>;
  if (!cookbook) {
    return (
      <div className="space-y-2">
        <p className="text-stone-600">Cookbook not found.</p>
        <Link to="/admin/global-toc" className="text-sm underline">
          ← Back to list
        </Link>
      </div>
    );
  }

  return (
    <CookbookForm
      cookbook={cookbook}
      onSaved={() => qc.invalidateQueries({ queryKey: ['global-cookbook', cookbook.id] })}
    />
  );
}

function CookbookForm({
  cookbook,
  onSaved,
}: {
  cookbook: GlobalCookbook;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(() => toForm(cookbook));
  const [olStatus, setOlStatus] = useState<string | null>(null);

  // If the underlying record changes (e.g. after an OL fetch + save),
  // pull the new values back into the form.
  useEffect(() => {
    setForm(toForm(cookbook));
  }, [cookbook]);

  const save = useMutation({
    mutationFn: () =>
      updateCookbook(cookbook.id, {
        title: form.title || 'Untitled cookbook',
        isbn: form.isbn || null,
        author: form.author,
        publisher: form.publisher,
        publication_year: form.publication_year
          ? Number.parseInt(form.publication_year, 10)
          : null,
        cover_image_path: form.cover_image_path || null,
        notes: form.notes,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['global-cookbooks'] });
      onSaved();
    },
  });

  const fetchOl = useMutation({
    mutationFn: async () => {
      setOlStatus(null);
      const normalized = normalizeIsbn(form.isbn);
      if (!normalized) throw new Error('Enter a valid ISBN-10 or ISBN-13 first.');
      return fetchFromOpenLibrary(normalized, cookbook.id);
    },
    onSuccess: (result) => {
      setForm((prev) => ({
        ...prev,
        isbn: normalizeIsbn(prev.isbn) ?? prev.isbn,
        title: result.metadata?.title || prev.title,
        author: result.metadata?.author || prev.author,
        publisher: result.metadata?.publisher || prev.publisher,
        publication_year:
          result.metadata?.publicationYear?.toString() || prev.publication_year,
        cover_image_path: result.coverImagePath ?? prev.cover_image_path,
      }));
      const bits: string[] = [];
      if (result.metadata) bits.push('metadata');
      if (result.coverImagePath) bits.push('cover');
      setOlStatus(
        bits.length === 0
          ? 'Open Library has no record for this ISBN. Fields unchanged.'
          : `Populated from Open Library: ${bits.join(' + ')}. Click Save to keep it.`,
      );
    },
    onError: (err) => setOlStatus((err as Error).message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-stone-600">
        <Link to="/admin/global-toc" className="underline">
          ← Back to list
        </Link>
      </div>

      {cookbook.shared_from_collection_id && (
        <div className="rounded-md border border-sky-300 bg-sky-50 dark:bg-sky-950/40 px-3 py-2 text-xs text-sky-900 dark:text-sky-100">
          Linked to a user's library cookbook. Edits to the title, author, publisher, year,
          ISBN, or cover propagate back to that source row on save. (Recipe titles don't sync —
          those stay user-curated.)
        </div>
      )}

      <div className="flex gap-4">
        <CoverDropZone
          cookbookId={cookbook.id}
          currentPath={form.cover_image_path}
          onUploaded={(path) => setForm((prev) => ({ ...prev, cover_image_path: path }))}
          alt={form.title || 'cookbook'}
        />
        <div className="flex-1 space-y-3">
          <Field label="Title">
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label="ISBN">
            <div className="flex gap-2">
              <input
                value={form.isbn}
                onChange={(e) => setForm({ ...form, isbn: e.target.value })}
                placeholder="ISBN-10 or ISBN-13"
                className="flex-1 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => fetchOl.mutate()}
                disabled={fetchOl.isPending || !form.isbn.trim()}
                className="rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-60"
              >
                {fetchOl.isPending ? 'Fetching…' : 'Fetch from Open Library'}
              </button>
            </div>
          </Field>
          {olStatus && <p className="text-xs text-stone-600">{olStatus}</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Author">
          <input
            value={form.author}
            onChange={(e) => setForm({ ...form, author: e.target.value })}
            className="w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Publisher">
          <input
            value={form.publisher}
            onChange={(e) => setForm({ ...form, publisher: e.target.value })}
            className="w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Year">
          <input
            value={form.publication_year}
            onChange={(e) =>
              setForm({ ...form, publication_year: e.target.value.replace(/[^\d]/g, '') })
            }
            className="w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Cover storage path">
          <input
            value={form.cover_image_path}
            onChange={(e) => setForm({ ...form, cover_image_path: e.target.value })}
            placeholder="global/<id>.jpg"
            className="w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm font-mono"
          />
        </Field>
      </div>

      <Field label="Notes (publicly readable)">
        <textarea
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          rows={3}
          className="w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm"
        />
      </Field>

      <div className="flex gap-2">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-md bg-stone-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
        >
          {save.isPending ? 'Saving…' : 'Save cookbook'}
        </button>
        {save.error && (
          <span className="self-center text-sm text-red-700">
            {(save.error as Error).message}
          </span>
        )}
      </div>

      <hr className="border-stone-200" />

      <TocEditor cookbookId={cookbook.id} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium uppercase tracking-wide text-stone-500">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

// ---------- ToC editor ----------

interface DraftRow {
  key: string;
  title: string;
  page: string;
}

function rowsFrom(entries: GlobalTocEntry[]): DraftRow[] {
  return entries.map((e) => ({
    key: e.id,
    title: e.title,
    page: e.page_number?.toString() ?? '',
  }));
}

function TocEditor({ cookbookId }: { cookbookId: string }) {
  const qc = useQueryClient();
  const { data: entries, isLoading, error } = useQuery({
    queryKey: ['global-toc-entries', cookbookId],
    queryFn: () => listTocEntries(cookbookId),
  });

  const [rows, setRows] = useState<DraftRow[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (entries) {
      setRows(rowsFrom(entries));
      setDirty(false);
    }
  }, [entries]);

  const save = useMutation({
    mutationFn: () => {
      const drafts: TocEntryDraft[] = rows.map((r) => ({
        title: r.title,
        page_number: r.page ? Number.parseInt(r.page, 10) : null,
      }));
      return replaceTocEntries(cookbookId, drafts);
    },
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['global-toc-entries', cookbookId] });
    },
  });

  const update = (i: number, patch: Partial<DraftRow>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const remove = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    setRows((prev) => {
      const next = [...prev];
      const a = next[i]!;
      const b = next[j]!;
      next[i] = b;
      next[j] = a;
      return next;
    });
    setDirty(true);
  };
  const add = () => {
    setRows((prev) => [...prev, { key: `new-${Date.now()}-${prev.length}`, title: '', page: '' }]);
    setDirty(true);
  };

  const nonEmpty = useMemo(() => rows.filter((r) => r.title.trim() !== '').length, [rows]);

  if (isLoading) return <p className="text-stone-500">Loading table of contents…</p>;
  if (error) return <p className="text-red-700">{(error as Error).message}</p>;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Table of contents</h2>
        <span className="text-xs text-stone-500">
          {nonEmpty} {nonEmpty === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      <ol className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.key} className="flex items-center gap-2">
            <span className="w-8 text-right text-xs text-stone-500">{i + 1}.</span>
            <input
              value={r.title}
              onChange={(e) => update(i, { title: e.target.value })}
              placeholder="Recipe title"
              className="flex-1 rounded-md border border-stone-300 px-2 py-1 text-sm"
            />
            <input
              value={r.page}
              onChange={(e) => update(i, { page: e.target.value.replace(/[^\d]/g, '') })}
              placeholder="Page"
              className="w-16 rounded-md border border-stone-300 px-2 py-1 text-sm font-mono"
            />
            <button
              onClick={() => move(i, -1)}
              disabled={i === 0}
              aria-label="Move up"
              className="rounded px-1 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-30"
            >
              ↑
            </button>
            <button
              onClick={() => move(i, 1)}
              disabled={i === rows.length - 1}
              aria-label="Move down"
              className="rounded px-1 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-30"
            >
              ↓
            </button>
            <button
              onClick={() => remove(i)}
              aria-label="Remove entry"
              className="rounded px-1 text-xs text-red-700 hover:bg-red-50"
            >
              ✕
            </button>
          </li>
        ))}
      </ol>

      <div className="flex gap-2">
        <button
          onClick={add}
          className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
        >
          + Add entry
        </button>
        <button
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
        >
          {save.isPending ? 'Saving…' : 'Save table of contents'}
        </button>
        {save.error && (
          <span className="self-center text-sm text-red-700">
            {(save.error as Error).message}
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * Cover thumbnail with three replace paths:
 *   - Click "Replace" → file picker
 *   - Drag and drop an image onto the thumbnail
 *   - Focus the thumbnail and paste (Ctrl/Cmd-V) a copied image
 *
 * Upload goes through `uploadCoverFile`, which writes to
 * covers/global/<id>-<ts>.<ext> and sweeps older paths so storage
 * doesn't accumulate orphans. The new path is bubbled up via
 * onUploaded; the editor's draft saves it to the row on the next
 * Save cookbook click (no implicit row write here).
 */
function CoverDropZone({
  cookbookId,
  currentPath,
  onUploaded,
  alt,
}: {
  cookbookId: string;
  currentPath: string;
  onUploaded: (path: string) => void;
  alt: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (file: Blob) => {
      if (!file.type.startsWith('image/')) {
        throw new Error(`Not an image (${file.type || 'unknown type'}).`);
      }
      return uploadCoverFile(cookbookId, file);
    },
    onSuccess: (path) => {
      onUploaded(path);
      setError(null);
    },
    onError: (err) => setError((err as Error).message),
  });

  function onPaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imgItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    const file = imgItem?.getAsFile();
    if (file) {
      e.preventDefault();
      upload.mutate(file);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) upload.mutate(file);
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        role="button"
        tabIndex={0}
        aria-label="Cover image — paste or drop an image, or click Replace"
        onPaste={onPaste}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`relative h-32 w-24 flex-shrink-0 rounded-md border-2 ${
          dragging ? 'border-sky-500 ring-2 ring-sky-200' : 'border-stone-200 dark:border-stone-700'
        } focus:outline-none focus:ring-2 focus:ring-sky-400`}
      >
        <CoverImage
          path={currentPath || undefined}
          className="h-full w-full rounded-md"
          alt={`${alt} cover`}
        />
        {upload.isPending && (
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-stone-900/40 text-xs font-medium text-white">
            Uploading…
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          // Reset so the same file can be picked twice in a row.
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="text-xs text-stone-600 dark:text-stone-400 hover:underline"
      >
        Replace
      </button>
      <p className="text-[10px] leading-tight text-stone-500 text-center">
        Click, drag, or paste an image
      </p>
      {error && <p className="text-[10px] text-red-700">{error}</p>}
    </div>
  );
}
