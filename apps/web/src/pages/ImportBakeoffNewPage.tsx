import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { useCollectionPickerOptions } from '../data/queries.js';
import { useOcrKeys } from '../import/queries.js';
import { useSync } from '../local/SyncProvider.js';
import { uploadBatch, type UploadProgress } from '../import/uploadBatch.js';
import { kickOcr, seedBakeoffBatch } from '../import/api.js';
import {
  BakeoffVariantEditor,
  useBakeoffVariantState,
} from '../import/BakeoffVariantEditor.js';
import { CookbookCombobox } from '../import/CookbookCombobox.js';

type Step = 'source' | 'review' | 'uploading';

/**
 * New bakeoff import: upload pages like a normal batch, but each page
 * (or merged group) is OCR'd through every variant in the matrix. Saved
 * as a BAKEOFF import batch — pick winners per page, then save recipes.
 */
export function ImportBakeoffNewPage() {
  const { user } = useAuth();
  const { syncNow, flushOutbox, status: syncStatus } = useSync();
  const navigate = useNavigate();
  const { data: pickerOptions = [] } = useCollectionPickerOptions();
  const { data: ocrKeys = [] } = useOcrKeys();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('source');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [name, setName] = useState(() => `Bakeoff ${new Date().toLocaleDateString()}`);
  const [targetCollectionId, setTargetCollectionId] = useState('');
  const [importMode, setImportMode] = useState<'ocr-first' | 'group-first'>('group-first');
  const [variants, setVariants] = useBakeoffVariantState();
  const [progress, setProgress] = useState<UploadProgress | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const urls = files.map((f) =>
      f.type === 'application/pdf' ? '' : URL.createObjectURL(f),
    );
    setPreviews(urls);
    return () => {
      for (const u of urls) if (u) URL.revokeObjectURL(u);
    };
  }, [files]);

  const totalSizeMb = useMemo(
    () => (files.reduce((acc, f) => acc + f.size, 0) / 1_048_576).toFixed(1),
    [files],
  );

  const sourceKind = files.some(
    (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
  )
    ? 'PDF'
    : 'IMAGES';

  function addFiles(list: FileList | File[] | null | undefined) {
    if (!list) return;
    const next = [...files, ...Array.from(list)];
    setFiles(next);
    if (step === 'source') setStep('review');
  }

  async function startBakeoff() {
    if (!user || files.length === 0 || variants.length === 0) return;
    setError(undefined);
    setStep('uploading');
    try {
      const result = await uploadBatch(
        {
          ownerId: user.id,
          name: name.trim() || `Bakeoff ${new Date().toLocaleDateString()}`,
          targetCollectionId: targetCollectionId || null,
          defaultProvider: variants[0]!.provider,
          defaultModel: variants[0]!.model,
          fallbackProvider: null,
          fallbackModel: null,
          sourceKind,
          files,
          batchKind: 'BAKEOFF',
          bakeoffVariants: variants.map((v) => ({
            name: v.name,
            provider: v.provider,
            model: v.model,
            prompt: v.prompt,
            base_url: v.baseUrl,
          })),
          awaitGrouping: importMode === 'group-first',
        },
        setProgress,
      );
      // Push the new batch row to the server before seeding variants.
      // `syncNow()` returns the in-flight cycle if one is already
      // running, which can resolve before our just-enqueued
      // `import_batch_insert` outbox entry has actually flushed.
      // `flushOutbox` is a direct push that bypasses the cycle gate.
      await flushOutbox();
      await seedBakeoffBatch(
        result.batchId,
        variants.map((v) => ({
          name: v.name,
          provider: v.provider,
          model: v.model,
          prompt: v.prompt,
          base_url: v.baseUrl,
        })),
      );
      if (!result.batchId || importMode === 'ocr-first') {
        try {
          await kickOcr(result.batchId);
        } catch {
          // cron fallback
        }
      }
      await syncNow();
      navigate(
        importMode === 'group-first'
          ? `/import/${result.batchId}/group`
          : `/import/${result.batchId}`,
      );
    } catch (e) {
      setError((e as Error).message);
      setStep('review');
    }
  }

  if (step === 'uploading') {
    const pct =
      progress && progress.total > 0
        ? Math.min(100, Math.round((progress.done / progress.total) * 100))
        : 0;
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Uploading bakeoff…</h1>
        <div className="h-2 overflow-hidden rounded-full bg-stone-200">
          <div className="h-full bg-stone-900" style={{ width: `${pct}%` }} />
        </div>
        {syncStatus === 'syncing' && (
          <p className="text-xs text-stone-500">Syncing batch metadata…</p>
        )}
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link to="/import" className="text-sm text-stone-600 underline">
          ← Imports
        </Link>
        <h1 className="text-2xl font-semibold">New bakeoff</h1>
        <p className="text-sm text-stone-600">
          Upload cookbook pages and race multiple OCR configs against each one. Pick a winner per
          page, then save recipes like a normal import.
        </p>
      </header>

      {ocrKeys.length === 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Configure an OCR API key in{' '}
          <Link to="/settings" className="underline">
            Settings
          </Link>{' '}
          first.
        </div>
      )}

      {step === 'source' && (
        <section className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
            >
              Choose images
            </button>
            <button
              type="button"
              onClick={() => pdfInputRef.current?.click()}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
            >
              Upload PDF
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
          <input
            ref={pdfInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </section>
      )}

      {step === 'review' && (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">
              {files.length} {files.length === 1 ? 'page' : 'pages'} · {totalSizeMb} MB
            </h2>
            <Field label="Batch name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
              />
            </Field>
            <Field label="Target cookbook">
              <CookbookCombobox
                options={pickerOptions}
                value={targetCollectionId}
                onChange={setTargetCollectionId}
              />
            </Field>
            <fieldset className="rounded-lg border border-stone-200 p-3">
              <legend className="px-1 text-sm font-medium">Page grouping</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="flex gap-2 text-sm">
                  <input
                    type="radio"
                    checked={importMode === 'group-first'}
                    onChange={() => setImportMode('group-first')}
                  />
                  Group pages first, then OCR each group with every variant
                </label>
                <label className="flex gap-2 text-sm">
                  <input
                    type="radio"
                    checked={importMode === 'ocr-first'}
                    onChange={() => setImportMode('ocr-first')}
                  />
                  OCR each page with every variant, merge later if needed
                </label>
              </div>
            </fieldset>
          </section>

          <BakeoffVariantEditor variants={variants} onChange={setVariants} />

          <button
            type="button"
            data-testid="bakeoff-run"
            disabled={files.length === 0 || variants.length === 0 || ocrKeys.length === 0}
            onClick={() => void startBakeoff()}
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
          >
            Start bakeoff ({variants.length} variants × {files.length} files)
          </button>
        </>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-xs text-stone-600">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
