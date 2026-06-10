import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adaptRecipe } from '@cookyourbooks/domain';
import { fetchSharedRecipe } from '@cookyourbooks/db';
import { createPersonalCollection } from '@cookyourbooks/domain';
import { supabase } from '../supabase.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useSync } from '../local/SyncProvider.js';
import { getRecipeSummary } from '../local/repositories.js';
import { collectionRepo, recipeRepo } from '../data/repos.js';
import { LoadingState } from '../components/LoadingState.js';
import { useToast } from '../components/ToastProvider.js';
import { RecipeContentGrid, RecipeHeaderMeta } from '../recipe/RecipeBody.js';
import { useRecipeTextScale } from '../recipe/useRecipeTextScale.js';
import { usePinchTextScale } from '../recipe/usePinchTextScale.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stashed when an anon visitor taps "save" so the fork completes
 *  automatically once they're back here signed in (mirrors
 *  cookyourbooks.pendingShare in ShareIntentListener). */
const PENDING_FORK_KEY = 'cookyourbooks.pendingFork';

/** Title of the auto-created personal collection share-link forks land in. */
const SAVED_RECIPES_TITLE = 'Saved recipes';

/**
 * /r/:recipeId — the bare-uuid share link target. NOT behind RequireAuth:
 * anyone can open it, and RLS decides what they see (owner / household
 * co-member / public collection). Signed-in users whose local DB already has
 * the recipe are redirected to the canonical collection route for the full
 * page; everyone else gets a read-only remote-fetched view with a
 * fork-to-library CTA.
 */
export function SharedRecipePage() {
  const { recipeId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, loading: authLoading } = useAuth();
  const { localReady, hydrated, syncNow } = useSync();
  const { showToast } = useToast();
  const validId = !!recipeId && UUID_RE.test(recipeId);

  // Canonical-redirect probe: own + household-shared recipes live in local
  // SQLite. Wait for hydration so a fresh device doesn't false-miss.
  const localHit = useQuery({
    queryKey: ['shared-recipe-local', recipeId, user?.id],
    enabled: validId && !!user && localReady && hydrated,
    queryFn: async () => (await getRecipeSummary(recipeId!)) ?? null,
  });

  // Remote fetch: anon immediately; signed-in only after the local probe
  // settled without a hit (avoids a flash before the redirect). A signed-in
  // user mid-first-sync (local DB not hydrated yet) skips the probe and goes
  // straight to the network — their JWT resolves own/household/public.
  const localProbeUsable = localReady && hydrated;
  const remote = useQuery({
    queryKey: ['shared-recipe', recipeId, user?.id ?? 'anon'],
    enabled:
      validId &&
      !authLoading &&
      (!user ||
        (localProbeUsable ? localHit.isSuccess && localHit.data === null : true)),
    queryFn: () => fetchSharedRecipe(supabase, recipeId!),
    retry: 1,
  });

  const [forking, setForking] = useState(false);
  const forkedOnce = useRef(false);

  async function forkToLibrary(): Promise<void> {
    if (!user || !remote.data || forking) return;
    setForking(true);
    try {
      const repo = collectionRepo(user.id);
      const options = await repo.listPickerOptions();
      let targetId = options.find(
        (o) => o.sourceType === 'PERSONAL' && o.title === SAVED_RECIPES_TITLE,
      )?.id;
      if (!targetId) {
        const created = createPersonalCollection({
          title: SAVED_RECIPES_TITLE,
          description: 'Recipes saved from share links.',
        });
        await repo.save(created);
        targetId = created.id;
      }
      // adaptRecipe mints fresh ids for the whole graph (required — child
      // PKs are global) and records provenance via parentRecipeId.
      const fork = adaptRecipe(remote.data.recipe, {
        title: remote.data.recipe.title,
        notes: remote.data.recipe.notes,
      });
      await recipeRepo(targetId).save(fork);
      await qc.invalidateQueries();
      void syncNow();
      showToast('Saved to your library', 'success');
      navigate(`/collections/${targetId}/recipes/${fork.id}`);
    } catch (err) {
      showToast(`Couldn't save: ${(err as Error).message}`, 'warn', 6000);
    } finally {
      setForking(false);
    }
  }

  function requestSignUpToFork(): void {
    try {
      sessionStorage.setItem(PENDING_FORK_KEY, recipeId!);
    } catch {
      /* private mode — they'll just tap the button again after signing in */
    }
    navigate('/sign-up', { state: { from: `/r/${recipeId}` } });
  }

  // Complete a fork the visitor asked for before signing up/in.
  useEffect(() => {
    if (!user || !remote.data || forkedOnce.current) return;
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(PENDING_FORK_KEY);
      if (pending) sessionStorage.removeItem(PENDING_FORK_KEY);
    } catch {
      /* private mode */
    }
    if (pending && pending === recipeId) {
      forkedOnce.current = true;
      void forkToLibrary();
    }
    // forkToLibrary reads only refs/state that are set when this fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, remote.data, recipeId]);

  const textScale = useRecipeTextScale();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const textScaleRef = useRef(textScale.scale);
  textScaleRef.current = textScale.scale;
  const getTextScale = useRef(() => textScaleRef.current).current;
  usePinchTextScale(contentRef, getTextScale, textScale.setScale);

  if (!validId) {
    return <NotAvailable signedIn={!!user} recipeId={recipeId} />;
  }
  if (localHit.data) {
    return (
      <Navigate
        to={`/collections/${localHit.data.collectionId}/recipes/${localHit.data.id}`}
        replace
      />
    );
  }
  if (
    authLoading ||
    (user && localProbeUsable && !localHit.isSuccess) ||
    remote.isLoading ||
    (remote.isPending && !remote.isError)
  ) {
    return (
      <LoadingState surface="shared-recipe" hints={['Fetching the shared recipe…']} />
    );
  }
  if (remote.isError) {
    return (
      <p className="text-red-700 dark:text-red-300">
        Couldn’t load this recipe: {(remote.error as Error).message}
      </p>
    );
  }
  if (!remote.data) {
    return <NotAvailable signedIn={!!user} recipeId={recipeId} />;
  }

  const { recipe, collection } = remote.data;
  const isEmpty = recipe.ingredients.length === 0 && recipe.instructions.length === 0;

  return (
    <div className="space-y-6 overflow-x-clip" data-testid="shared-recipe-page">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-900 px-4 py-3 text-sm">
        <span className="text-stone-600 dark:text-stone-400">
          Shared recipe
          {collection ? (
            <>
              {' '}
              · from <span className="font-medium text-stone-900 dark:text-stone-100">{collection.title}</span>
            </>
          ) : null}
        </span>
        {user ? (
          <button
            type="button"
            onClick={() => void forkToLibrary()}
            disabled={forking}
            data-testid="fork-to-library"
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
          >
            {forking ? 'Saving…' : 'Save to my library'}
          </button>
        ) : (
          <button
            type="button"
            onClick={requestSignUpToFork}
            data-testid="fork-to-library"
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
          >
            Sign up to save this recipe
          </button>
        )}
      </div>

      <div>
        <RecipeHeaderMeta recipe={recipe} collection={collection ?? undefined} />
      </div>

      {isEmpty ? (
        <p className="text-stone-600 dark:text-stone-400">
          This recipe hasn’t been scanned in yet.
        </p>
      ) : (
        <div ref={contentRef}>
          <RecipeContentGrid recipe={recipe} textScale={textScale.scale} />
        </div>
      )}
    </div>
  );
}

function NotAvailable({ signedIn, recipeId }: { signedIn: boolean; recipeId?: string }) {
  return (
    <div
      className="mx-auto max-w-md rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-6 text-center"
      data-testid="shared-recipe-unavailable"
    >
      <h1 className="text-lg font-semibold">This recipe isn’t available</h1>
      <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
        {signedIn
          ? 'It may have been deleted, or you don’t have access to it.'
          : 'It may be private, or you may need to sign in to view it.'}
      </p>
      {!signedIn && recipeId && (
        <Link
          to="/sign-in"
          state={{ from: `/r/${recipeId}` }}
          className="mt-4 inline-block rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
        >
          Sign in to view
        </Link>
      )}
    </div>
  );
}
