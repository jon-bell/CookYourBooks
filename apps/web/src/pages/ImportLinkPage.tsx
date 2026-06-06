import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createRecipe, type ParsedRecipeDraft } from '@cookyourbooks/domain';
import { useAuth } from '../auth/AuthProvider.js';
import { useSync } from '../local/SyncProvider.js';
import { collectionRepo, recipeRepo } from '../data/repos.js';
import { withFreshIds } from '../import/draftToRecipe.js';
import {
  extractRecipeFromVideo,
  VideoImportError,
  type VideoImportResult,
} from '../import/videoImport.js';

type Phase = 'idle' | 'extracting' | 'picking' | 'saving';

/**
 * Paste a YouTube / TikTok / Instagram link → the `video-import` Edge
 * Function extracts the recipe(s) → save into a generic per-platform
 * collection. Also the deep-link landing for the mobile share target:
 * `?url=<link>` prefills and auto-extracts.
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
  // Guard so the deep-link auto-extract fires at most once.
  const autoRan = useRef(false);

  const saveDraft = useCallback(
    async (draft: ParsedRecipeDraft, res: VideoImportResult) => {
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
        const collectionId = await collections.findOrCreateWebCollectionByPlatform(
          res.platformTitle,
        );
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
        // One draft → save straight away; otherwise let the user pick.
        if (res.drafts.length === 1) {
          await saveDraft(res.drafts[0]!, res);
        } else {
          setPhase('picking');
        }
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
              <Link to="/settings" className="underline">
                Open settings
              </Link>{' '}
              to add one.
            </>,
          );
          setPhase('idle');
          return;
        }
        setError((e as Error).message);
        setPhase('idle');
      }
    },
    [saveDraft],
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
        Paste a YouTube, TikTok, or Instagram recipe link. We'll extract the
        recipe and add it to a collection for that site.
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
          aria-label="Video URL"
          placeholder="https://www.youtube.com/watch?v=…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          data-testid="video-url-input"
          className="rounded-md border border-stone-300 dark:border-stone-600 bg-transparent px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        />

        {needsCaption && (
          <div className="flex flex-col gap-1">
            <label htmlFor="video-caption" className="text-xs text-stone-600 dark:text-stone-400">
              We couldn't read this post automatically. Paste the recipe caption:
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
        <div className="mt-4">
          <h2 className="mb-2 text-base font-semibold">
            Found {result.drafts.length} recipes — pick one to save
          </h2>
          <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded border border-stone-200 dark:border-stone-700">
            {result.drafts.map((d, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => void saveDraft(d, result)}
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
        </div>
      )}
    </main>
  );
}

export default ImportLinkPage;
