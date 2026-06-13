import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createRecipe, type ParsedRecipeDraft } from '@cookyourbooks/domain';
import { useAuth } from '../auth/AuthProvider.js';
import { useSync } from '../local/SyncProvider.js';
import { reportError } from '../sentry.js';
import { collectionRepo, recipeRepo } from '../data/repos.js';
import { useCollectionPickerOptions } from '../data/queries.js';
import { CookbookCombobox } from '../import/CookbookCombobox.js';
import { withFreshIds } from '../import/draftToRecipe.js';
import { renderPdfToJpegs } from '../import/imageProcessing.js';
import { extractSourceUrlFromPdf } from '../import/pdfSourceUrl.js';
import { readSharedFile } from '../import/sharedFile.js';
import { extractRecipeFromPdf, PdfImportError, type PdfImportResult } from '../import/pdfImport.js';

type Phase = 'idle' | 'reading' | 'extracting' | 'saving';

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
  // Guard so the deep-link auto-run fires at most once.
  const autoRan = useRef(false);

  const saveDraft = useCallback(
    async (draft: ParsedRecipeDraft, res: PdfImportResult, targetCollectionId: string) => {
      if (!user) return;
      setPhase('saving');
      setStatus('Saving recipe…');
      const { ingredients, instructions } = withFreshIds(draft);
      const recipe = createRecipe({
        title: draft.title?.trim() || 'Untitled',
        servings: draft.servings,
        ingredients,
        instructions,
        description: draft.description,
        timeEstimate: draft.timeEstimate,
        equipment: draft.equipment,
        sourceImageText: draft.sourceImageText,
        sourceUrl: res.sourceUrl ?? undefined,
      });
      const collections = collectionRepo(user.id);
      // Re-attributed to an existing collection, or (default) the auto-detected
      // per-platform website collection, created on demand.
      const collectionId =
        targetCollectionId ||
        (await collections.findOrCreateWebCollectionByPlatform(res.platformTitle));
      await recipeRepo(collectionId).save(recipe);
      qc.invalidateQueries({ queryKey: ['collections', user.id] });
      qc.invalidateQueries({ queryKey: ['library-summaries', user.id] });
      qc.invalidateQueries({ queryKey: ['collection', collectionId] });
      qc.invalidateQueries({ queryKey: ['collection-picker', user.id] });
      void syncNow();
      navigate(`/collections/${collectionId}/recipes/${recipe.id}`);
    },
    [user, qc, syncNow, navigate],
  );

  const processFile = useCallback(
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
              PDF import needs a Gemini API key.{' '}
              <Link to="/settings/llm" className="underline">
                Open settings
              </Link>{' '}
              to add one.
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
      <h1 className="mb-1 text-xl font-semibold">Import from a PDF</h1>
      <p className="mb-4 text-sm text-stone-600 dark:text-stone-400">
        Share a recipe PDF to CookYourBooks — or pick one below. Print a paywalled
        recipe to PDF in Safari, then share it here: we'll read every page into one
        recipe and link back to the original page.
      </p>

      {!params.get('file') && !pending && (
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

      {busy && (
        <p className="mt-4 text-sm text-stone-600 dark:text-stone-400" role="status">
          {status || 'Working…'}
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
            <CookbookCombobox
              options={pickerOptions}
              value={destId}
              onChange={setDestId}
              unassignedLabel={`New: ${pending.res.platformTitle}`}
            />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Defaults to a new “{pending.res.platformTitle}” collection — pick an
              existing one to file it there instead.
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
