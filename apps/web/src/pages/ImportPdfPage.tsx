import type { ParsedRecipeDraft } from '@cookyourbooks/domain';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider.js';
import { useCollectionPickerOptions } from '../data/queries.js';
import { getEffectiveOcrConfig } from '../import/api.js';
import { CollectionPicker } from '../import/CollectionPicker.js';
import { readPdfPageCount, renderPdfToJpegs } from '../import/imageProcessing.js';
import { takePendingPdf } from '../import/pdfHandoff.js';
import { extractRecipeFromPdf, PdfImportError, type PdfImportResult } from '../import/pdfImport.js';
import { type PdfScope, PdfScopeStep } from '../import/PdfScopeStep.js';
import { extractSourceUrlFromPdf } from '../import/pdfSourceUrl.js';
import { saveSingleShotDraft } from '../import/saveSingleShot.js';
import { readSharedFile } from '../import/sharedFile.js';
import { uploadBatch, type UploadProgress } from '../import/uploadBatch.js';
import { useSync } from '../local/SyncProvider.js';
import { reportError } from '../sentry.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../settings/ocrSettings.js';

type Phase = 'idle' | 'counting' | 'reading' | 'extracting' | 'saving' | 'uploading';

/** Parsed-but-not-yet-saved import, held while the user confirms a destination. */
interface Pending {
  draft: ParsedRecipeDraft;
  res: PdfImportResult;
}

/**
 * Import a recipe from a PDF — the landing for the iOS "share a PDF" flow
 * (`?file=<file://…>` points at the shared file in the app group container).
 * Renders the PDF's pages, reads the source URL from the print header/footer,
 * OCRs all pages into ONE recipe (server-side `pdf-import`), and saves it into
 * a per-source collection. Also accepts a directly-picked PDF on the web.
 */
export function ImportPdfPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { syncNow } = useSync();
  const qc = useQueryClient();
  const [params] = useSearchParams();

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<React.ReactNode | undefined>();
  const [status, setStatus] = useState<string>('');
  // Parsed recipe awaiting a destination choice (the re-attribution step).
  const [pending, setPending] = useState<Pending | null>(null);
  // '' = file under the auto-detected platform collection (created on demand);
  // any other value = an existing collection the user re-attributed to.
  const [destId, setDestId] = useState('');
  const { data: pickerOptions = [] } = useCollectionPickerOptions();
  // A picked/shared PDF waiting on the "one recipe or a cookbook?" answer.
  const [scopeAsk, setScopeAsk] = useState<{ file: File; pageCount: number } | null>(null);
  const [progress, setProgress] = useState<UploadProgress | undefined>();
  // Guard so the deep-link auto-run fires at most once.
  const autoRan = useRef(false);

  const saveDraft = useCallback(
    async (draft: ParsedRecipeDraft, res: PdfImportResult, targetCollectionId: string) => {
      if (!user) return;
      setPhase('saving');
      setStatus('Saving recipe…');
      const { collectionId, recipeId } = await saveSingleShotDraft({
        ownerId: user.id,
        draft,
        platformTitle: res.platformTitle,
        sourceUrl: res.sourceUrl,
        targetCollectionId,
        qc,
      });
      void syncNow();
      navigate(`/collections/${collectionId}/recipes/${recipeId}`);
    },
    [user, qc, syncNow, navigate],
  );

  /** "This is one recipe": every page read together into a single recipe. */
  const extractAsOneRecipe = useCallback(
    async (file: File) => {
      setError(undefined);
      try {
        setPhase('reading');
        setStatus('Reading PDF pages…');
        const pages = await renderPdfToJpegs(file, (done, total) =>
          setStatus(`Rendering page ${done} of ${total}…`),
        );
        if (pages.length === 0) {
          setError('That PDF had no pages we could read.');
          setPhase('idle');
          return;
        }
        const sourceUrl = await extractSourceUrlFromPdf(file);

        setPhase('extracting');
        setStatus(`Reading recipe from ${pages.length} page${pages.length === 1 ? '' : 's'}…`);
        const res = await extractRecipeFromPdf(
          pages.map((p) => p.fullJpeg),
          { sourceUrl },
        );
        // Whole PDF → one recipe: hold the first (and usually only) draft and
        // let the user confirm/re-attribute the destination collection.
        const draft = res.drafts[0];
        if (!draft) {
          setError('No recipe found in that PDF.');
          setPhase('idle');
          return;
        }
        // Default to an existing per-platform website collection when one is
        // already there, so re-importing from the same source coalesces.
        const existing = pickerOptions.find(
          (o) => o.sourceType === 'WEBSITE' && o.title === res.platformTitle,
        );
        setDestId(existing?.id ?? '');
        setPending({ draft, res });
        setPhase('idle');
      } catch (e) {
        if (e instanceof PdfImportError && e.code === 'NO_GEMINI_KEY') {
          setError(
            <>
              Importing isn't set up yet.{' '}
              <Link to="/import/setup" className="underline">
                Set up importing
              </Link>{' '}
              to get started.
            </>,
          );
          setPhase('idle');
          return;
        }
        // EXTRACTION_FAILED / file-read failure / UNKNOWN — swallowed into inline
        // UI, so report it or a shared PDF that "does nothing" stays invisible.
        reportError(e, {
          operation: 'pdf_import',
          tags: { code: e instanceof PdfImportError ? e.code : 'UNKNOWN' },
        });
        setError((e as Error).message);
        setPhase('idle');
      }
    },
    [pickerOptions],
  );

  /**
   * "This is a cookbook": hand the PDF to the standard bulk pipeline, which
   * splits it one item per page and drops the user on the batch board. Same
   * call the Upload-photos door makes, so both produce identical batches.
   */
  const splitIntoBatch = useCallback(
    async (file: File) => {
      if (!user) return;
      setError(undefined);
      setPhase('uploading');
      try {
        const cfg = await getEffectiveOcrConfig().catch(() => null);
        const defaultProvider = cfg?.provider ?? 'gemini';
        const { batchId } = await uploadBatch(
          {
            ownerId: user.id,
            name: file.name.replace(/\.pdf$/i, '') || `Imported ${new Date().toLocaleDateString()}`,
            targetCollectionId: null,
            defaultProvider,
            defaultModel: cfg?.model || DEFAULT_MODEL_BY_PROVIDER[defaultProvider],
            defaultEndpoint: cfg?.endpoint ?? null,
            defaultPrompt: cfg?.prompt ?? null,
            fallbackProvider: cfg?.fallbackProvider ?? null,
            fallbackModel: cfg?.fallbackModel ?? null,
            fallbackEndpoint: cfg?.fallbackEndpoint ?? null,
            keyOwnerId: cfg?.source === 'household' ? cfg.keyOwnerId : null,
            sourceKind: 'PDF',
            files: [file],
          },
          setProgress,
        );
        await syncNow();
        navigate(`/import/${batchId}`);
      } catch (e) {
        reportError(e, { operation: 'batch_upload', tags: { source: 'pdf' } });
        setError((e as Error).message);
        setPhase('idle');
      }
    },
    [user, syncNow, navigate],
  );

  /**
   * Entry for every PDF, shared or picked: count the pages (cheap — no
   * render), then ask what the file is before doing the expensive work.
   */
  const processFile = useCallback(async (file: File) => {
    setError(undefined);
    setPending(null);
    try {
      setPhase('counting');
      setStatus('Reading PDF…');
      const pageCount = await readPdfPageCount(file);
      if (pageCount === 0) {
        setError('That PDF had no pages we could read.');
        setPhase('idle');
        return;
      }
      setPhase('idle');
      setScopeAsk({ file, pageCount });
    } catch (e) {
      reportError(e, { operation: 'pdf_import', tags: { code: 'PAGE_COUNT_FAILED' } });
      setError((e as Error).message);
      setPhase('idle');
    }
  }, []);

  const onScopeChosen = useCallback(
    (scope: PdfScope) => {
      const ask = scopeAsk;
      if (!ask) return;
      setScopeAsk(null);
      void (scope === 'one' ? extractAsOneRecipe(ask.file) : splitIntoBatch(ask.file));
    },
    [scopeAsk, extractAsOneRecipe, splitIntoBatch],
  );

  // Forwarded from the Upload-photos door (a PDF dropped/picked there). Runs
  // once; empty after a reload, where the file picker below takes over.
  useEffect(() => {
    if (autoRan.current) return;
    const handed = takePendingPdf();
    if (handed) {
      autoRan.current = true;
      // Deferred like the share-intent effect below, so the state updates
      // inside processFile don't run synchronously in the effect body.
      void (async () => {
        await processFile(handed);
      })();
    }
  }, [processFile]);

  // Deep-link / share entry: ?file=<file://…> reads the shared PDF and runs once.
  useEffect(() => {
    const fileUrl = params.get('file');
    if (fileUrl && !autoRan.current) {
      autoRan.current = true;
      void (async () => {
        try {
          const file = await readSharedFile(fileUrl, { mimeType: 'application/pdf' });
          await processFile(file);
        } catch (e) {
          reportError(e, { operation: 'pdf_import', tags: { code: 'READ_FAILED' } });
          setError("Couldn't read the shared PDF. Try opening the app and sharing again.");
          setPhase('idle');
        }
      })();
    }
  }, [params, processFile]);

  const busy = phase !== 'idle';

  return (
    <main className="mx-auto max-w-xl p-4">
      <Link
        to="/import"
        className="mb-2 inline-block text-sm text-stone-500 underline-offset-2 hover:underline dark:text-stone-400"
      >
        ← Add recipes
      </Link>
      <h1 className="mb-1 text-xl font-semibold">Import from a PDF</h1>
      <p className="mb-4 text-sm text-stone-600 dark:text-stone-400">
        Share a recipe PDF to CookYourBooks — or pick one below. Print a paywalled recipe to PDF in
        Safari, then share it here: we'll read it into a recipe and link back to the original page.
        A scanned cookbook can be split into one recipe per page instead — we'll ask.
      </p>

      {!params.get('file') && !pending && !scopeAsk && (
        <label className="flex flex-col gap-2">
          <span className="text-sm">Choose a PDF</span>
          <input
            type="file"
            accept="application/pdf"
            disabled={busy}
            data-testid="pdf-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void processFile(file);
            }}
            className="text-sm"
          />
        </label>
      )}

      {scopeAsk && !busy && (
        <div className="mt-4">
          <PdfScopeStep
            pageCount={scopeAsk.pageCount}
            fileName={scopeAsk.file.name}
            onConfirm={onScopeChosen}
            onCancel={() => setScopeAsk(null)}
          />
        </div>
      )}

      {busy && (
        <p className="mt-4 text-sm text-stone-600 dark:text-stone-400" role="status">
          {phase === 'uploading' && progress
            ? `${progress.message ?? 'Uploading'} ${progress.done}/${progress.total}`
            : status || 'Working…'}
        </p>
      )}

      {pending && !busy && (
        <div className="mt-4 space-y-3 rounded-lg border border-stone-200 dark:border-stone-700 p-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Recipe
            </div>
            <div className="font-medium">{pending.draft.title?.trim() || 'Untitled'}</div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Save to collection</label>
            <CollectionPicker
              options={pickerOptions}
              value={destId}
              onChange={setDestId}
              unassignedLabel={`New: ${pending.res.platformTitle}`}
            />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Defaults to a new “{pending.res.platformTitle}” collection — pick an existing one to
              file it there instead.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="pdf-import-save"
              onClick={() => void saveDraft(pending.draft, pending.res, destId)}
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
            >
              Save recipe
            </button>
            <button
              type="button"
              onClick={() => {
                setPending(null);
                setDestId('');
              }}
              className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
    </main>
  );
}

export default ImportPdfPage;
