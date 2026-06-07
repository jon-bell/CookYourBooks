import { useEffect, useRef, useState } from 'react';
import { CoverImage } from '../components/CoverImage.js';
import { useBookMetadataLookup } from './bookLookup.js';
import { applyMatch, type BookForm } from './bookForm.js';
import { scanIsbnFromImage, IsbnScanError } from './scanIsbn.js';

// Shared cookbook-metadata fields used by every "add / edit a cookbook"
// entry point. The ISBN field auto-looks-up against our catalog then Open
// Library and autofills empty fields + a cover; the "Scan" button reads the
// ISBN off a cover/barcode photo via the isbn-scan Edge Function.

export function BookMetadataFields({
  value,
  onChange,
}: {
  value: BookForm;
  onChange: (next: BookForm) => void;
}) {
  const lookup = useBookMetadataLookup(value.isbn);
  const appliedRef = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Autofill once per resolved ISBN; applyMatch only fills empty fields so it
  // never clobbers what the user typed.
  useEffect(() => {
    if (!lookup.match || !lookup.triedIsbn) return;
    if (appliedRef.current === lookup.triedIsbn) return;
    appliedRef.current = lookup.triedIsbn;
    onChange(applyMatch(value, lookup.match));
    // value/onChange intentionally omitted — we apply at most once per ISBN.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup.match, lookup.triedIsbn]);

  async function onScanFile(file: File) {
    setScanning(true);
    setScanError(null);
    try {
      const isbn = await scanIsbnFromImage(file);
      if (!isbn) {
        setScanError('No ISBN found in that photo. Try the barcode on the back.');
        return;
      }
      // New ISBN → let the lookup re-fire and autofill.
      appliedRef.current = null;
      onChange({ ...value, isbn });
    } catch (e) {
      setScanError(
        e instanceof IsbnScanError && e.code === 'NO_GEMINI_KEY'
          ? 'Scanning needs a Gemini API key — add one in Settings.'
          : (e as Error).message,
      );
    } finally {
      setScanning(false);
    }
  }

  const hasCover = !!value.coverImagePath || !!value.coverPreviewUrl;

  return (
    <div className="space-y-4">
      <Field label="ISBN">
        <div className="flex gap-2">
          <input
            value={value.isbn}
            onChange={(e) => onChange({ ...value, isbn: e.target.value })}
            placeholder="ISBN-10 or ISBN-13 (optional)"
            className="w-full rounded border border-stone-300 dark:border-stone-600 bg-transparent px-3 py-2 font-mono"
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={scanning}
            className="shrink-0 rounded-md border border-stone-300 dark:border-stone-600 px-3 py-2 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
          >
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onScanFile(f);
              e.target.value = '';
            }}
          />
        </div>
        <LookupHint lookup={lookup} />
        {scanError && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{scanError}</p>}
      </Field>

      <Field label="Title">
        <input
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
          required
          className="w-full rounded border border-stone-300 dark:border-stone-600 bg-transparent px-3 py-2"
        />
      </Field>

      <Field label="Author">
        <input
          value={value.author}
          onChange={(e) => onChange({ ...value, author: e.target.value })}
          className="w-full rounded border border-stone-300 dark:border-stone-600 bg-transparent px-3 py-2"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Publisher">
          <input
            value={value.publisher}
            onChange={(e) => onChange({ ...value, publisher: e.target.value })}
            className="w-full rounded border border-stone-300 dark:border-stone-600 bg-transparent px-3 py-2"
          />
        </Field>
        <Field label="Year">
          <input
            value={value.publicationYear}
            onChange={(e) => onChange({ ...value, publicationYear: e.target.value })}
            inputMode="numeric"
            className="w-full rounded border border-stone-300 dark:border-stone-600 bg-transparent px-3 py-2"
          />
        </Field>
      </div>

      {hasCover && (
        <div className="flex items-center gap-3">
          {value.coverImagePath ? (
            <CoverImage
              path={value.coverImagePath}
              className="h-20 w-14 flex-shrink-0 rounded border border-stone-200 dark:border-stone-700"
            />
          ) : (
            <img
              src={value.coverPreviewUrl}
              alt="Cover preview"
              className="h-20 w-14 flex-shrink-0 rounded border border-stone-200 dark:border-stone-700 object-cover"
            />
          )}
          <button
            type="button"
            onClick={() =>
              onChange({ ...value, coverImagePath: undefined, coverBlob: null, coverPreviewUrl: undefined })
            }
            className="text-xs text-stone-500 hover:text-red-700 dark:hover:text-red-300"
          >
            Remove cover
          </button>
        </div>
      )}
    </div>
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

function LookupHint({ lookup }: { lookup: ReturnType<typeof useBookMetadataLookup> }) {
  if (!lookup.triedIsbn) return null;
  if (lookup.isLoading) {
    return <p className="mt-2 text-xs text-stone-500">Looking up book details…</p>;
  }
  if (!lookup.match) {
    return (
      <p className="mt-2 text-xs text-stone-500">
        No match found — fill in the details by hand.
      </p>
    );
  }
  const m = lookup.match;
  const source = m.source === 'catalog' ? 'our catalog' : 'Open Library';
  return (
    <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">
      Found “{m.title}”{m.author ? ` · ${m.author}` : ''} via {source}.
      {m.tocEntries && m.tocEntries.length > 0 && ` ${m.tocEntries.length} known recipes.`}
    </p>
  );
}
