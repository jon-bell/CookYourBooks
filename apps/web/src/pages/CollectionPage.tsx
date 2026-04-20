import { Link, useNavigate, useParams } from 'react-router-dom';
import type { RecipeCollection } from '@cookyourbooks/domain';
import {
  useCollection,
  useDeleteCollection,
  useReorderRecipes,
  useSaveCollection,
} from '../data/queries.js';
import { CoverImageEditor } from '../components/CoverImageEditor.js';
import { ImportFromPhoto } from '../import/ImportFromPhoto.js';
import { SortableRecipeList } from '../components/SortableRecipeList.js';
import { CopyLinkButton } from '../share/CopyLinkButton.js';
import { collectionShareUrl } from '../share/shareUrl.js';

export function CollectionPage() {
  const { collectionId } = useParams();
  const navigate = useNavigate();
  const { data: collection, isLoading, error } = useCollection(collectionId);
  const deleteCollection = useDeleteCollection();
  const saveCollection = useSaveCollection();
  const reorderRecipes = useReorderRecipes(collectionId ?? '');

  if (isLoading) return <p className="text-stone-500">Loading…</p>;
  if (error) return <p className="text-red-700">{(error as Error).message}</p>;
  if (!collection) return <p className="text-stone-600">Collection not found.</p>;

  const c = collection;

  async function togglePublic() {
    await saveCollection.mutateAsync({ ...c, isPublic: !c.isPublic } as RecipeCollection);
  }

  async function onCoverChange(newPath: string | undefined) {
    await saveCollection.mutateAsync({ ...c, coverImagePath: newPath } as RecipeCollection);
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs uppercase tracking-wide text-stone-500">{subtitle(c)}</div>
        <h1 className="mt-1 text-2xl font-semibold">{c.title}</h1>
        {c.sourceType === 'PERSONAL' && c.description && (
          <p className="mt-2 text-stone-600">{c.description}</p>
        )}
      </div>

      {c.moderationState === 'TAKEN_DOWN' && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <div className="font-medium">This collection was taken down by a moderator.</div>
          {c.moderationReason && (
            <div className="mt-1">
              Reason: <span className="italic">{c.moderationReason}</span>
            </div>
          )}
          <div className="mt-2 text-amber-800">
            It is not visible on Discover and cannot be re-published without moderator review.
            Your local recipes and edits are untouched.
          </div>
        </div>
      )}

      <CoverImageEditor collection={c} onChange={onCoverChange} />

      <div className="flex flex-wrap items-center gap-3">
        <Link
          to={`/collections/${c.id}/recipes/new`}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800"
        >
          Add recipe
        </Link>
        <ImportFromPhoto collectionId={c.id} />
        <button
          onClick={togglePublic}
          disabled={saveCollection.isPending || c.moderationState === 'TAKEN_DOWN'}
          title={
            c.moderationState === 'TAKEN_DOWN'
              ? 'Taken down by a moderator'
              : undefined
          }
          className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-50"
        >
          {c.isPublic ? 'Make private' : 'Make public'}
        </button>
        {c.isPublic && c.moderationState !== 'TAKEN_DOWN' && (
          <CopyLinkButton
            url={collectionShareUrl(c.id)}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
          />
        )}
        <button
          onClick={async () => {
            if (confirm(`Delete "${c.title}" and all its recipes?`)) {
              await deleteCollection.mutateAsync(c.id);
              navigate('/');
            }
          }}
          className="rounded-md px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
        >
          Delete collection
        </button>
      </div>

      {c.recipes.length === 0 ? (
        <p className="text-stone-600">No recipes yet.</p>
      ) : (
        <SortableRecipeList
          collectionId={c.id}
          recipes={c.recipes}
          onReorder={(ids) => reorderRecipes.mutateAsync(ids)}
        />
      )}
    </div>
  );
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
