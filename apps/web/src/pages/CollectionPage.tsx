import type { RecipeCollection } from '@cookyourbooks/domain';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider.js';
import { CollectionCoverDialog } from '../books/CollectionCoverDialog.js';
import { EditBookDetailsDialog } from '../books/EditBookDetailsDialog.js';
import { CollectionNotesSection } from '../components/CollectionNotesSection.js';
import { CollectionRecipeBrowser } from '../components/CollectionRecipeBrowser.js';
import { CoverImageEditor } from '../components/CoverImageEditor.js';
import { DuplicateRecipesTool } from '../components/DuplicateRecipesTool.js';
import { GenerateCoversButton } from '../components/GenerateCoversButton.js';
import { LoadingState } from '../components/LoadingState.js';
import { MakePublicDialog } from '../components/MakePublicDialog.js';
import { ShareToGlobalButton } from '../components/ShareToGlobalButton.js';
import {
  useCollectionMeta,
  useCollectionRecipeSummaries,
  useDeleteCollection,
  useReorderRecipes,
  useSaveCollection,
  useToggleRecipeFavorite,
} from '../data/queries.js';
import { CollectionShareSection } from '../household/CollectionShareSection.js';
import { ImportFromPhoto } from '../import/ImportFromPhoto.js';
import { useCollectionNotes } from '../notes/queries.js';
import { CopyLinkButton } from '../share/CopyLinkButton.js';
import { collectionShareUrl } from '../share/shareUrl.js';
export function CollectionPage() {
  const { collectionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: collection, isLoading, error } = useCollectionMeta(collectionId);
  const { data: recipeSummaries } = useCollectionRecipeSummaries(collectionId);
  const { data: notes } = useCollectionNotes(collectionId);
  const deleteCollection = useDeleteCollection();
  const saveCollection = useSaveCollection();
  const reorderRecipes = useReorderRecipes(collectionId ?? '');
  const toggleFavorite = useToggleRecipeFavorite();
  const [showPublishWarning, setShowPublishWarning] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [generatingCover, setGeneratingCover] = useState(false);
  const [tab, setTab] = useState<'recipes' | 'notes'>('recipes');

  if (isLoading) return <LoadingState surface="collection" />;
  if (error) return <p className="text-red-700 dark:text-red-300">{error.message}</p>;
  if (!collection)
    return <p className="text-stone-600 dark:text-stone-400">Collection not found.</p>;

  const c = collection;
  const recipes = recipeSummaries ?? [];
  const noteCount = notes?.length ?? 0;
  // Hard rule mirrored at the DB layer: a PUBLISHED_BOOK with an ISBN
  // contains copyrighted material and can never be public.
  const isbnBlocksPublic = c.sourceType === 'PUBLISHED_BOOK' && !!c.isbn && c.isbn.trim() !== '';

  function onPublicClick() {
    if (c.isPublic) {
      void togglePublic();
    } else {
      // First-time publish goes through the DMCA / zero-tolerance dialog.
      setShowPublishWarning(true);
    }
  }

  async function togglePublic() {
    setShowPublishWarning(false);
    await saveCollection.mutateAsync({ ...c, isPublic: !c.isPublic });
  }

  async function onCoverChange(newPath: string | undefined) {
    await saveCollection.mutateAsync({ ...c, coverImagePath: newPath });
  }

  async function onToggleFavorite(recipeId: string) {
    if (!collectionId) return;
    await toggleFavorite.mutateAsync({ collectionId, recipeId });
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
          {subtitle(c)}
        </div>
        <h1 className="mt-1 text-2xl font-semibold">{c.title}</h1>
        {c.sourceType === 'PERSONAL' && c.description && (
          <p className="mt-2 text-stone-600 dark:text-stone-400">{c.description}</p>
        )}
      </div>

      {c.moderationState === 'TAKEN_DOWN' && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-200"
        >
          <div className="font-medium">This collection was taken down by a moderator.</div>
          {c.moderationReason && (
            <div className="mt-1">
              Reason: <span className="italic">{c.moderationReason}</span>
            </div>
          )}
          <div className="mt-2 text-amber-800 dark:text-amber-300">
            It is not visible on Discover and cannot be re-published without moderator review. Your
            local recipes and edits are untouched.
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <CoverImageEditor collection={c} onChange={onCoverChange} />
        <button
          type="button"
          onClick={() => setGeneratingCover(true)}
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          Generate collection cover
        </button>
      </div>

      {user && (
        <CollectionCoverDialog
          open={generatingCover}
          onClose={() => setGeneratingCover(false)}
          userId={user.id}
          collectionId={c.id}
          collectionTitle={c.title}
          previousCoverPath={c.coverImagePath}
          recipes={recipes}
          onCoverSaved={onCoverChange}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Link
          to={`/collections/${c.id}/recipes/new`}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
        >
          Add recipe
        </Link>
        <ImportFromPhoto collectionId={c.id} />
        {recipes.length > 0 && (
          <GenerateCoversButton scope="collection" targetId={c.id} label="Generate covers" />
        )}
        {c.sourceType === 'PUBLISHED_BOOK' && (
          <button
            onClick={() => setEditingDetails(true)}
            className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Edit details
          </button>
        )}
        <button
          onClick={onPublicClick}
          disabled={
            saveCollection.isPending ||
            c.moderationState === 'TAKEN_DOWN' ||
            (isbnBlocksPublic && !c.isPublic)
          }
          title={
            c.moderationState === 'TAKEN_DOWN'
              ? 'Taken down by a moderator'
              : isbnBlocksPublic && !c.isPublic
                ? "Cookbooks with an ISBN can't be made public — those recipes belong to the publisher. See /legal/dmca to report a violation."
                : undefined
          }
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
        >
          {c.isPublic ? 'Make private' : 'Make public'}
        </button>
        {c.isPublic && c.moderationState !== 'TAKEN_DOWN' && (
          <CopyLinkButton
            url={collectionShareUrl(c.id)}
            className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
          />
        )}
        {c.sourceType === 'PUBLISHED_BOOK' && c.moderationState !== 'TAKEN_DOWN' && (
          <ShareToGlobalButton cookbook={c} />
        )}
        {c.moderationState !== 'TAKEN_DOWN' && <CollectionShareSection />}
        <button
          onClick={async () => {
            if (confirm(`Delete "${c.title}" and all its recipes?`)) {
              await deleteCollection.mutateAsync(c.id);
              navigate('/library');
            }
          }}
          className="rounded-md px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
        >
          Delete collection
        </button>
      </div>

      <DuplicateRecipesTool collectionId={c.id} recipes={recipes} />

      {/* Notes get their own tab so a cookbook with many multi-page notes
          doesn't bury the recipe grid (they used to stack above it). */}
      <div className="space-y-4">
        <div
          role="tablist"
          aria-label="Collection contents"
          className="flex gap-1 border-b border-stone-200 dark:border-stone-700"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'recipes'}
            onClick={() => setTab('recipes')}
            className={tabClass(tab === 'recipes')}
          >
            Recipes{recipes.length > 0 ? ` (${recipes.length})` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'notes'}
            onClick={() => setTab('notes')}
            className={tabClass(tab === 'notes')}
          >
            Notes{noteCount > 0 ? ` (${noteCount})` : ''}
          </button>
        </div>

        {tab === 'recipes' ? (
          recipes.length === 0 ? (
            <p className="text-stone-600 dark:text-stone-400">No recipes yet.</p>
          ) : (
            <CollectionRecipeBrowser
              collectionId={c.id}
              recipes={recipes}
              onReorder={(ids) => reorderRecipes.mutateAsync(ids)}
              onToggleFavorite={onToggleFavorite}
            />
          )
        ) : (
          <CollectionNotesSection collectionId={c.id} />
        )}
      </div>
      {c.sourceType === 'PUBLISHED_BOOK' && (
        <EditBookDetailsDialog
          cookbook={c}
          open={editingDetails}
          onClose={() => setEditingDetails(false)}
        />
      )}
      <MakePublicDialog
        open={showPublishWarning}
        collectionTitle={c.title}
        onCancel={() => setShowPublishWarning(false)}
        onConfirm={() => void togglePublic()}
        isPending={saveCollection.isPending}
      />
    </div>
  );
}

function tabClass(active: boolean): string {
  return [
    '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
    active
      ? 'border-stone-900 text-stone-900 dark:border-stone-100 dark:text-stone-100'
      : 'border-transparent text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200',
  ].join(' ');
}

function subtitle(c: RecipeCollection): string {
  switch (c.sourceType) {
    case 'PUBLISHED_BOOK':
      return c.author ? `Cookbook · ${c.author}` : 'Cookbook';
    case 'WEBSITE':
      return c.siteName ? `Web · ${c.siteName}` : 'Web';
    case 'PERSONAL':
      return 'Personal';
  }
}
