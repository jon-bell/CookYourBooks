import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatQuantity, isMeasured } from '@cookyourbooks/domain';
import { useCollection } from '../data/queries.js';

// Fires a light haptic tap on platforms that support it. On web the
// Capacitor plugin no-ops; on iOS/Android it triggers the native engine.
async function hapticTick(): Promise<void> {
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Module missing or platform unsupported — not worth surfacing.
  }
}

function advance(setIdx: React.Dispatch<React.SetStateAction<number>>, total: number): void {
  setIdx((i) => {
    const next = Math.min(total - 1, i + 1);
    if (next !== i) void hapticTick();
    return next;
  });
}

function retreat(setIdx: React.Dispatch<React.SetStateAction<number>>): void {
  setIdx((i) => {
    const next = Math.max(0, i - 1);
    if (next !== i) void hapticTick();
    return next;
  });
}

export function CookModePage() {
  const { collectionId, recipeId } = useParams();
  const { data: collection } = useCollection(collectionId);
  const recipe = collection?.recipes.find((r) => r.id === recipeId);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> };
    };
    if (nav.wakeLock) {
      nav.wakeLock
        .request('screen')
        .then((lock) => {
          wakeLock = lock;
        })
        .catch(() => {
          /* ignore */
        });
    }
    return () => {
      wakeLock?.release().catch(() => {});
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!recipe) return;
      if (e.key === 'ArrowRight' || e.key === ' ') {
        advance(setIdx, recipe.instructions.length);
      } else if (e.key === 'ArrowLeft') {
        retreat(setIdx);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recipe]);

  if (!collection || !recipe) return <p className="text-stone-600">Recipe not found.</p>;
  const total = recipe.instructions.length;
  const step = recipe.instructions[idx];
  // Referenced ingredients for this step — the user's editor-time
  // annotation. Filter out any stale ids pointing at since-deleted
  // ingredients.
  const ingredientById = new Map(recipe.ingredients.map((ing) => [ing.id, ing]));
  const stepIngredients = (step?.ingredientRefs ?? [])
    .map((r) => ingredientById.get(r.ingredientId))
    .filter(<T,>(x: T | undefined): x is T => x !== undefined);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Link
          to={`/collections/${collection.id}/recipes/${recipe.id}`}
          className="text-sm text-stone-600 hover:underline"
        >
          ← {recipe.title}
        </Link>
        <span className="text-sm text-stone-500">
          Step {idx + 1} of {total}
        </span>
      </div>

      <div className="rounded-xl bg-white p-8 shadow-sm ring-1 ring-stone-200">
        <div className="text-6xl font-light text-stone-300">{idx + 1}</div>
        {stepIngredients.length > 0 && (
          <ul
            aria-label="Ingredients for this step"
            className="mt-4 flex flex-wrap gap-2 text-sm"
          >
            {stepIngredients.map((ing) => (
              <li
                key={ing.id}
                className="rounded-full bg-amber-50 px-3 py-1 text-amber-900 ring-1 ring-amber-200"
              >
                {isMeasured(ing) ? (
                  <>
                    <span className="font-medium">{formatQuantity(ing.quantity)}</span> {ing.name}
                  </>
                ) : (
                  ing.name
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-2xl leading-relaxed">{step?.text ?? ''}</p>
      </div>

      <aside className="rounded-lg bg-white p-4 ring-1 ring-stone-200">
        <h3 className="mb-2 text-sm font-semibold text-stone-700">Ingredients</h3>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3">
          {recipe.ingredients.map((ing) => (
            <li key={ing.id}>
              {isMeasured(ing) ? (
                <>
                  <span className="font-medium">{formatQuantity(ing.quantity)}</span> {ing.name}
                </>
              ) : (
                ing.name
              )}
            </li>
          ))}
        </ul>
      </aside>

      <div className="sticky bottom-0 flex items-stretch gap-3 pt-4">
        <button
          onClick={() => retreat(setIdx)}
          disabled={idx === 0}
          aria-label="Previous step"
          className="flex-1 rounded-md bg-stone-900 px-5 py-4 text-lg text-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        >
          ← Previous
        </button>
        <button
          onClick={() => advance(setIdx, total)}
          disabled={idx >= total - 1}
          aria-label="Next step"
          className="flex-1 rounded-md bg-stone-900 px-5 py-4 text-lg text-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
