import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Recipe } from '@cookyourbooks/domain';

/**
 * A drag-and-drop-reorderable list of recipes. Submits the new order by
 * calling `onReorder` with the full list of ids in display order. The
 * parent is responsible for persisting — we keep this component stateless
 * about sync so it's easy to unit-test.
 *
 * Keyboard accessibility: focus a row and press Space to lift, arrow keys
 * to move, Space/Enter to drop (provided by @dnd-kit).
 */
export function SortableRecipeList({
  collectionId,
  recipes,
  onReorder,
}: {
  collectionId: string;
  recipes: readonly Recipe[];
  onReorder: (orderedIds: string[]) => Promise<void> | void;
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

  const byId = new Map(recipes.map((r) => [r.id, r]));

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
          {ids.map((id) => {
            const recipe = byId.get(id);
            if (!recipe) return null;
            return (
              <SortableRow key={id} id={id} collectionId={collectionId} recipe={recipe} />
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
}: {
  id: string;
  collectionId: string;
  recipe: Recipe;
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
      <Link
        to={`/collections/${collectionId}/recipes/${recipe.id}`}
        className="flex flex-1 items-center justify-between py-3 pr-4 hover:bg-stone-50"
      >
        <span className="font-medium">{recipe.title}</span>
        <span className="text-sm text-stone-500">
          {recipe.ingredients.length} ing · {recipe.instructions.length} steps
        </span>
      </Link>
    </li>
  );
}
