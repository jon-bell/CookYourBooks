import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import type { CollectionRecipeSummary } from '../local/repositories.js';
import { CoverImage } from './CoverImage.js';
// Sort logic lives in recipeSort.ts (pure, no component imports — unit tests
// use it without pulling the supabase client into the module graph).
// Re-exported here so existing component-side importers keep working.
import { type RecipeSortMode, sortRecipes } from './recipeSort.js';
export { isRecipeSortMode, sortByLastMade, sortRecipes } from './recipeSort.js';
export type { RecipeSortMode } from './recipeSort.js';

const UL_CLASS =
  'divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900';

/** "p. 42" / "pp. 42, 51" / null when the recipe carries no page. */
export function formatPages(pageNumbers: readonly number[] | undefined): string | null {
  const ps = [...(pageNumbers ?? [])].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (ps.length === 0) return null;
  return ps.length === 1 ? `p. ${ps[0]}` : `pp. ${ps.join(', ')}`;
}

/**
 * A reorderable list of recipes. In `manual` sort mode it's drag-and-drop:
 * dropping submits the new order via `onReorder` (the parent persists).
 * In `name`/`page` mode it's a read-only sorted view (drag disabled — a
 * derived sort has no manual order to save). Every row shows the page
 * number when known.
 *
 * Keyboard accessibility (manual mode): focus a row and press Space to
 * lift, arrow keys to move, Space/Enter to drop (provided by @dnd-kit).
 */
export function SortableRecipeList({
  collectionId,
  recipes,
  onReorder,
  onToggleStar,
  sortMode = 'manual',
  lastMade,
}: {
  collectionId: string;
  recipes: readonly CollectionRecipeSummary[];
  onReorder: (orderedIds: string[]) => Promise<void> | void;
  /** When provided, renders a ★/☆ button per row. The Speed Importer
   *  queue is derived from `recipes.starred`; placeholders are the
   *  usual target but starring is allowed on filled recipes too. */
  onToggleStar?: (recipeId: string) => Promise<void> | void;
  sortMode?: RecipeSortMode;
  /** recipeId → latest COOKED date; required for `sortMode === 'made'`. */
  lastMade?: ReadonlyMap<string, string>;
}) {
  // Keep a local mirror of the order so the drop animates before the
  // server round-trip. Re-sync from props when the incoming list changes.
  const [ids, setIds] = useState<string[]>(() => recipes.map((r) => r.id));
  useEffect(() => {
    setIds(recipes.map((r) => r.id));
  }, [recipes]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(ids, oldIndex, newIndex);
    setIds(next);
    void onReorder(next);
  }

  // Derived sort: read-only, no drag affordance.
  if (sortMode !== 'manual') {
    return (
      <ul className={UL_CLASS}>
        {sortRecipes(recipes, sortMode, lastMade).map((recipe) => (
          <li key={recipe.id} className="flex items-center gap-2 pl-3">
            <RecipeRowBody
              collectionId={collectionId}
              recipe={recipe}
              onToggleStar={onToggleStar}
            />
          </li>
        ))}
      </ul>
    );
  }

  const byId = new Map(recipes.map((r) => [r.id, r]));
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className={UL_CLASS}>
          {ids.map((id) => {
            const recipe = byId.get(id);
            if (!recipe) return null;
            return (
              <SortableRow
                key={id}
                id={id}
                collectionId={collectionId}
                recipe={recipe}
                onToggleStar={onToggleStar}
              />
            );
          })}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  id,
  collectionId,
  recipe,
  onToggleStar,
}: {
  id: string;
  collectionId: string;
  recipe: CollectionRecipeSummary;
  onToggleStar?: (recipeId: string) => Promise<void> | void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : undefined,
    background: isDragging ? '#fafaf9' : undefined,
  };
  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-2">
      <button
        type="button"
        aria-label={`Reorder ${recipe.title}`}
        className="flex h-12 w-8 shrink-0 cursor-grab items-center justify-center text-stone-400 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <span aria-hidden>⋮⋮</span>
      </button>
      <RecipeRowBody collectionId={collectionId} recipe={recipe} onToggleStar={onToggleStar} />
    </li>
  );
}

/** The shared visual body of a row: optional star button + the link with
 *  title, page number, and ingredient/step summary. Used by both the
 *  draggable and read-only rows. */
function RecipeRowBody({
  collectionId,
  recipe,
  onToggleStar,
}: {
  collectionId: string;
  recipe: CollectionRecipeSummary;
  onToggleStar?: (recipeId: string) => Promise<void> | void;
}) {
  // A "placeholder" recipe is a ToC entry the user hasn't imported /
  // hand-entered yet. Render it muted so the imported ones pop.
  const isPlaceholder = recipe.ingredientCount === 0 && recipe.instructionCount === 0;
  const starred = recipe.starred;
  const pages = formatPages(recipe.pageNumbers);
  return (
    <>
      {onToggleStar && (
        <button
          type="button"
          aria-label={starred ? `Unstar ${recipe.title}` : `Star ${recipe.title}`}
          aria-pressed={starred}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void onToggleStar(recipe.id);
          }}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 ${
            starred
              ? 'text-amber-500 hover:text-amber-600'
              : 'text-stone-300 hover:text-amber-500 dark:text-stone-600'
          }`}
          title={
            starred
              ? 'Starred — queued for Speed Importer'
              : isPlaceholder
                ? 'Star to queue for Speed Importer scanning'
                : 'Star this recipe'
          }
        >
          <span aria-hidden>{starred ? '★' : '☆'}</span>
        </button>
      )}
      <Link
        to={`/collections/${collectionId}/recipes/${recipe.id}`}
        title={recipe.title}
        className={`flex flex-1 flex-col gap-0.5 py-3 pr-4 hover:bg-stone-50 dark:hover:bg-stone-900 sm:flex-row sm:items-center sm:justify-between ${
          isPlaceholder ? 'text-stone-500 dark:text-stone-500' : ''
        }`}
      >
        <span className="flex items-center gap-2 min-w-0">
          {!isPlaceholder && recipe.coverImagePath && (
            <CoverImage
              path={recipe.coverImagePath}
              alt=""
              className="h-8 w-8 shrink-0 rounded border border-stone-200 dark:border-stone-700"
              variant="thumb"
            />
          )}
          <span className={`line-clamp-2 min-w-0 ${isPlaceholder ? '' : 'font-medium'}`}>
            {recipe.title}
          </span>
          {pages && (
            <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">· {pages}</span>
          )}
          {isPlaceholder && (
            <span className="shrink-0 rounded border border-stone-300 dark:border-stone-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Not imported
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400 sm:text-sm">
          {isPlaceholder ? '—' : `${recipe.ingredientCount} ing · ${recipe.instructionCount} steps`}
        </span>
      </Link>
    </>
  );
}
