import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createRegistry,
  formatQuantity,
  formatServings,
  isMeasured,
  recipeToMarkdown,
  scaleRecipe,
  Units,
  type Quantity,
  exact,
} from '@cookyourbooks/domain';
import { useCollection, useDeleteRecipe } from '../data/queries.js';
import { shareRecipe } from '../share/share.js';

export function RecipePage() {
  const { collectionId, recipeId } = useParams();
  const navigate = useNavigate();
  const { data: collection, isLoading } = useCollection(collectionId);
  const recipe = collection?.recipes.find((r) => r.id === recipeId);
  const deleteRecipe = useDeleteRecipe(collectionId ?? '');

  const [scale, setScale] = useState(1);
  const [targetUnit, setTargetUnit] = useState<string>('');

  const registry = useMemo(() => createRegistry(), []);
  const scaled = useMemo(() => (recipe ? scaleRecipe(recipe, scale) : undefined), [recipe, scale]);

  if (isLoading) return <p className="text-stone-500">Loading…</p>;
  if (!collection || !recipe || !scaled) {
    return <p className="text-stone-600">Recipe not found.</p>;
  }

  function displayQuantity(q: Quantity, ingredientName: string): string {
    if (!targetUnit || targetUnit === q.unit) return formatQuantity(q);
    const factor = registry.findFactor(q.unit, targetUnit, ingredientName);
    if (factor === undefined) return formatQuantity(q);
    const n = quantityValue(q);
    return formatQuantity(exact(n * factor, targetUnit));
  }

  async function shareAsMarkdown() {
    const md = recipeToMarkdown(scaled!);
    // shareRecipe picks the right surface: native share sheet on device,
    // Web Share API where supported, Markdown download on desktop browsers.
    await shareRecipe({ title: recipe!.title, markdown: md });
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/collections/${collection.id}`} className="text-sm text-stone-600 hover:underline">
          ← {collection.title}
        </Link>
        <h1 className="mt-1 text-3xl font-semibold">{recipe.title}</h1>
        {scaled.servings && (
          <p className="mt-1 text-stone-600">Serves {formatServings(scaled.servings)}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-stone-200 bg-white p-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-stone-600">Scale</span>
          <input
            type="number"
            min={0.25}
            step={0.25}
            value={scale}
            onChange={(e) => setScale(Math.max(0.25, Number(e.target.value) || 1))}
            className="w-20 rounded border border-stone-300 px-2 py-1"
          />
          <span className="text-stone-500">×</span>
        </label>
        <div className="flex items-center gap-2 text-sm">
          {[0.5, 1, 2, 3].map((v) => (
            <button
              key={v}
              onClick={() => setScale(v)}
              className={`rounded px-2 py-1 ${
                scale === v ? 'bg-stone-900 text-white' : 'hover:bg-stone-100'
              }`}
            >
              {v}×
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-stone-600">Convert to</span>
          <select
            value={targetUnit}
            onChange={(e) => setTargetUnit(e.target.value)}
            className="rounded border border-stone-300 px-2 py-1"
          >
            <option value="">original units</option>
            {Object.values(Units).map((u) => (
              <option key={u.name} value={u.name}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex gap-2">
          <Link
            to={`/collections/${collection.id}/recipes/${recipe.id}/cook`}
            className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800"
          >
            Cook mode
          </Link>
          <Link
            to={`/collections/${collection.id}/recipes/${recipe.id}/edit`}
            className="rounded-md px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100"
          >
            Edit
          </Link>
          <button
            onClick={shareAsMarkdown}
            className="rounded-md px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
          >
            Share
          </button>
          <button
            onClick={async () => {
              if (confirm(`Delete "${recipe.title}"?`)) {
                await deleteRecipe.mutateAsync(recipe.id);
                navigate(`/collections/${collection.id}`);
              }
            }}
            className="rounded-md px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
          >
            Delete
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <section className="md:col-span-1 space-y-2">
          <h2 className="text-lg font-semibold">Ingredients</h2>
          <ul className="space-y-1.5">
            {scaled.ingredients.map((ing) => (
              <li key={ing.id} className="text-sm">
                {isMeasured(ing) ? (
                  <>
                    <span className="font-medium">
                      {displayQuantity(ing.quantity, ing.name)}
                    </span>{' '}
                    {ing.name}
                    {ing.preparation && (
                      <span className="text-stone-500">, {ing.preparation}</span>
                    )}
                  </>
                ) : (
                  <>
                    {ing.name}
                    {ing.preparation && (
                      <span className="text-stone-500">, {ing.preparation}</span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="md:col-span-2 space-y-2">
          <h2 className="text-lg font-semibold">Instructions</h2>
          <ol className="space-y-3">
            {scaled.instructions.map((step) => (
              <li key={step.id} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-900 text-xs font-medium text-white">
                  {step.stepNumber}
                </span>
                <span>{step.text}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

function quantityValue(q: Quantity): number {
  switch (q.type) {
    case 'EXACT':
      return q.amount;
    case 'FRACTIONAL':
      return q.whole + q.numerator / q.denominator;
    case 'RANGE':
      return (q.min + q.max) / 2;
  }
}

