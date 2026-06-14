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
import {
  extractRecipeFromVideo,
  VideoImportError,
  type VideoImportResult,
} from '../import/videoImport.js';

type Phase = 'idle' | 'extracting' | 'picking' | 'saving';

/**
 * Paste any recipe link — a YouTube / TikTok / Instagram video or a generic
 * recipe website — and the `video-import` Edge Function extracts the
 * recipe(s) → save into a per-source collection. Also the deep-link landing
 * for the mobile share target: `?url=<link>` prefills and auto-extracts.
 */
export function ImportLinkPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { syncNow } = useSync();
  const qc = useQueryClient();
  const [params] = useSearchParams();

  const [url, setUrl] = useState(params.get('url') ?? '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<React.ReactNode | undefined>();
  const [needsCaption, setNeedsCaption] = useState(false);
  const [caption, setCaption] = useState('');
  const [result, setResult] = useState<VideoImportResult | undefined>();
  // '' = file under the auto-detected platform collection (created on demand);
  // any other value = an existing collection the user re-attributed to.
  const [destId, setDestId] = useState('');
  const { data: pickerOptions = [] } = useCollectionPickerOptions();
  // Guard so the deep-link auto-extract fires at most once.
  const autoRan = useRef(false);

  const saveDraft = useCallback(
    async (draft: ParsedRecipeDraft, res: VideoImportResult, targetCollectionId: string) => {
      if (!user) return;
      setPhase('saving');
      setError(undefined);
      try {
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
          sourceUrl: res.sourceUrl,
        });
        const collections = collectionRepo(user.id);
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
      } catch (e) {
        setError((e as Error).message);
        setPhase('picking');
      }
    },
    [user, qc, syncNow, navigate],
  );

  // Default the destination to an existing per-platform website collection when
  // one already exists, so re-importing from the same source coalesces.
  const defaultDestFor = useCallback(
    (platformTitle: string) =>
      pickerOptions.find((o) => o.sourceType === 'WEBSITE' && o.title === platformTitle)?.id ?? '',
    [pickerOptions],
  );

  const run = useCallback(
    async (targetUrl: string, withCaption?: string) => {
      const trimmed = targetUrl.trim();
      if (!trimmed) return;
      setPhase('extracting');
      setError(undefined);
      try {
        const res = await extractRecipeFromVideo(trimmed, { caption: withCaption });
        setResult(res);
        setNeedsCaption(false);
        // Stop at the picking step so the user can confirm — or re-attribute —
        // the destination collection before the recipe is saved.
        setDestId(defaultDestFor(res.platformTitle));
        setPhase('picking');
      } catch (e) {
        if (e instanceof VideoImportError && e.code === 'NEEDS_CAPTION') {
          setNeedsCaption(true);
          setPhase('idle');
          return;
        }
        if (e instanceof VideoImportError && e.code === 'NO_GEMINI_KEY') {
          setError(
            <>
              Video import needs a Gemini API key.{' '}
              <Link to="/settings/llm" className="underline">
                Open settings
              </Link>{' '}
              to add one.
            </>,
          );
          setPhase('idle');
          return;
        }
        // A genuine failure (EXTRACTION_FAILED / UNSUPPORTED_URL / UNKNOWN) —
        // these get swallowed into inline UI state, so without this they're
        // invisible. Report so a share that "does nothing" (e.g. paywalled
        // NYT Cooking) surfaces in Sentry, tagged with the host + code.
        let host: string | undefined;
        try {
          host = new URL(trimmed).hostname;
        } catch {
          host = undefined;
        }
        reportError(e, {
          operation: 'video_import',
          tags: {
            code: e instanceof VideoImportError ? e.code : 'UNKNOWN',
            host,
            platform: e instanceof VideoImportError ? e.platform : undefined,
          },
        });
        setError((e as Error).message);
        setPhase('idle');
      }
    },
    [defaultDestFor],
  );

  // Deep-link / share-target entry: ?url= auto-extracts once.
  useEffect(() => {
    const incoming = params.get('url');
    if (incoming && !autoRan.current) {
      autoRan.current = true;
      setUrl(incoming);
      void run(incoming);
    }
  }, [params, run]);

  const busy = phase === 'extracting' || phase === 'saving';

  return (
    <main className="mx-auto max-w-xl p-4">
      <h1 className="mb-1 text-xl font-semibold">Import from a link</h1>
      <p className="mb-4 text-sm text-stone-600 dark:text-stone-400">
        Paste any recipe link — a YouTube, TikTok, or Instagram video, or a
        recipe website. We'll extract the recipe and add it to a collection for
        that site.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(url, needsCaption ? caption : undefined);
        }}
        className="flex flex-col gap-3"
      >
        <input
          type="url"
          inputMode="url"
          aria-label="Recipe URL"
          placeholder="https://… (video or recipe site)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          data-testid="video-url-input"
          className="rounded-md border border-stone-300 dark:border-stone-600 bg-transparent px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        />

        {needsCaption && (
          <div className="flex flex-col gap-1">
            <label htmlFor="video-caption" className="text-xs text-stone-600 dark:text-stone-400">
              We couldn't read this automatically (some sites block us or sit behind
              a paywall). Paste the recipe text — ingredients and steps:
            </label>
            <textarea
              id="video-caption"
              aria-label="Recipe caption"
              rows={6}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              disabled={busy}
              data-testid="video-caption-input"
              className="rounded-md border border-stone-300 dark:border-stone-600 bg-transparent px-3 py-2 text-sm"
            />
          </div>
        )}

        <div>
          <button
            type="submit"
            disabled={busy || !url.trim() || (needsCaption && !caption.trim())}
            className="rounded-md border border-stone-300 dark:border-stone-600 px-4 py-2 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
          >
            {phase === 'extracting'
              ? 'Reading video…'
              : phase === 'saving'
                ? 'Saving…'
                : 'Extract recipe'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}

      {phase === 'picking' && result && (
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Save to collection</label>
            <CookbookCombobox
              options={pickerOptions}
              value={destId}
              onChange={setDestId}
              unassignedLabel={`New: ${result.platformTitle}`}
            />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Defaults to a new “{result.platformTitle}” collection — pick an
              existing one to file it there instead.
            </p>
          </div>

          {result.drafts.length === 1 ? (
            <button
              type="button"
              data-testid="video-import-save"
              onClick={() => void saveDraft(result.drafts[0]!, result, destId)}
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
            >
              Save recipe
            </button>
          ) : (
            <>
              <h2 className="text-base font-semibold">
                Found {result.drafts.length} recipes — pick one to save
              </h2>
              <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded border border-stone-200 dark:border-stone-700">
                {result.drafts.map((d, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => void saveDraft(d, result, destId)}
                      className="block w-full px-3 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-900"
                    >
                      <div className="font-medium">{d.title ?? `Recipe ${i + 1}`}</div>
                      <div className="text-xs text-stone-500 dark:text-stone-400">
                        {d.ingredients.length} ingredients · {d.instructions.length} steps
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </main>
  );
}

export default ImportLinkPage;
