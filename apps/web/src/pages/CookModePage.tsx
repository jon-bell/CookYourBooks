import { formatQuantity, isMeasured } from '@cookyourbooks/domain';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { LoadingState } from '../components/LoadingState.js';
import { TimerButton } from '../cook/TimerButton.js';
import { useRecipe } from '../data/queries.js';

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
  // Just the one recipe — cook mode never needs the rest of the collection.
  const { data: recipe, isLoading } = useRecipe(collectionId, recipeId);
  const [idx, setIdx] = useState(0);
  // Ephemeral check-off state. Reset on every Cook Mode entry (the
  // component remounts) — we intentionally don't persist across
  // sessions because the most common signal is "I just walked away
  // for ten minutes," not "I want to pick up where I left off three
  // days later."
  const [ingredientChecks, setIngredientChecks] = useState<Set<string>>(() => new Set());
  const [substepChecks, setSubstepChecks] = useState<Set<string>>(() => new Set());

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

  if (isLoading) return <LoadingState surface="cook-mode" />;
  if (!recipe) return <p className="text-stone-600 dark:text-stone-400">Recipe not found.</p>;
  const total = recipe.instructions.length;
  const step = recipe.instructions[idx];
  // Referenced ingredients for this step — the user's editor-time
  // annotation. Filter out any stale ids pointing at since-deleted
  // ingredients. Preserve the per-step `quantity` on each ref so we
  // can render "use 2 cup flour" rather than the full ingredient
  // total when the source recipe tells us how much.
  const ingredientById = new Map(recipe.ingredients.map((ing) => [ing.id, ing]));
  const stepIngredients = (step?.ingredientRefs ?? [])
    .map((r) => {
      const ing = ingredientById.get(r.ingredientId);
      if (!ing) return undefined;
      return { ing, consumed: r.quantity };
    })
    .filter(<T,>(x: T | undefined): x is T => x !== undefined);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Link
          to={`/collections/${collectionId}/recipes/${recipe.id}`}
          className="text-sm text-stone-600 dark:text-stone-400 hover:underline"
        >
          ← {recipe.title}
        </Link>
        <span className="text-sm text-stone-500 dark:text-stone-400">
          Step {idx + 1} of {total}
        </span>
      </div>

      <div className="rounded-xl bg-white dark:bg-stone-900 p-8 shadow-sm ring-1 ring-stone-200">
        <div className="text-6xl font-light text-stone-300">{idx + 1}</div>
        {stepIngredients.length > 0 && (
          <ul aria-label="Ingredients for this step" className="mt-4 flex flex-wrap gap-2 text-sm">
            {stepIngredients.map(({ ing, consumed }) => {
              // Prefer the step's explicit "consumed" quantity (from
              // OCR's consumedIngredients). Fall back to the
              // ingredient's full quantity only when measured.
              const q = consumed ?? (isMeasured(ing) ? ing.quantity : undefined);
              return (
                <li
                  key={ing.id}
                  className="rounded-full bg-amber-50 dark:bg-amber-950/40 px-3 py-1 text-amber-900 dark:text-amber-200 ring-1 ring-amber-200"
                >
                  {q ? (
                    <>
                      <span className="font-medium">{formatQuantity(q)}</span> {ing.name}
                    </>
                  ) : (
                    ing.name
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {step?.temperature && (
          <p className="mt-3 text-lg text-stone-600 dark:text-stone-400">
            {step.temperature.value}°{step.temperature.unit === 'FAHRENHEIT' ? 'F' : 'C'}
          </p>
        )}
        {step?.simplifiedSteps && step.simplifiedSteps.length > 0 ? (
          <>
            <p className="mt-4 text-base text-stone-500 dark:text-stone-400">{step.text}</p>
            <ol className="mt-3 space-y-2" data-testid="simplified-list">
              {step.simplifiedSteps.map((ss, i) => {
                const key = `${step.id}:${i}`;
                const checked = substepChecks.has(key);
                return (
                  <li key={key} className="flex items-start gap-3 text-2xl leading-snug">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        setSubstepChecks((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(key);
                          else next.delete(key);
                          return next;
                        });
                      }}
                      className="mt-2 h-5 w-5 shrink-0 accent-stone-900 dark:accent-stone-100"
                      aria-label={`Mark step ${i + 1} done`}
                    />
                    <span
                      className={
                        checked
                          ? 'flex-1 text-stone-400 line-through dark:text-stone-500'
                          : 'flex-1'
                      }
                    >
                      {ss.text}
                      {ss.temperature && (
                        <span className="ml-2 align-middle text-base text-amber-700 dark:text-amber-300">
                          {ss.temperature.value}°{ss.temperature.unit === 'FAHRENHEIT' ? 'F' : 'C'}
                        </span>
                      )}
                      {ss.notes && (
                        <span className="ml-2 align-middle text-base italic text-stone-500 dark:text-stone-400">
                          {ss.notes}
                        </span>
                      )}
                    </span>
                    {ss.durationSec != null && ss.durationSec > 0 && (
                      <TimerButton
                        durationSec={ss.durationSec}
                        persistKey={`cyb:timer:${recipe.id}:${key}`}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <>
            <p className="mt-4 text-2xl leading-relaxed">{step?.text ?? ''}</p>
            {step?.subInstructions && step.subInstructions.length > 0 && (
              <ul className="mt-3 ml-6 list-disc space-y-1 text-lg text-stone-700 dark:text-stone-300">
                {step.subInstructions.map((sub, i) => (
                  <li key={i}>{sub}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {step?.notes && (
          <p className="mt-3 text-base italic text-stone-500 dark:text-stone-400">{step.notes}</p>
        )}
      </div>

      <aside className="rounded-lg bg-white dark:bg-stone-900 p-4 ring-1 ring-stone-200">
        <h3 className="mb-2 text-sm font-semibold text-stone-700 dark:text-stone-300">
          Ingredients
        </h3>
        <ul
          className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3"
          data-testid="cook-ingredients"
        >
          {recipe.ingredients.map((ing) => {
            const checked = ingredientChecks.has(ing.id);
            return (
              <li key={ing.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    setIngredientChecks((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(ing.id);
                      else next.delete(ing.id);
                      return next;
                    });
                  }}
                  className="h-4 w-4 shrink-0 accent-stone-900 dark:accent-stone-100"
                  aria-label={`Mark ${ing.name} ready`}
                />
                <span className={checked ? 'text-stone-400 line-through dark:text-stone-500' : ''}>
                  {isMeasured(ing) ? (
                    <>
                      <span className="font-medium">{formatQuantity(ing.quantity)}</span> {ing.name}
                    </>
                  ) : (
                    ing.name
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="sticky bottom-0 flex items-stretch gap-3 pt-4 pb-[env(safe-area-inset-bottom)]">
        <button
          onClick={() => retreat(setIdx)}
          disabled={idx === 0}
          aria-label="Previous step"
          className="flex-1 rounded-md bg-stone-900 dark:bg-stone-100 px-5 py-4 text-lg text-white dark:text-stone-900 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        >
          ← Previous
        </button>
        <button
          onClick={() => advance(setIdx, total)}
          disabled={idx >= total - 1}
          aria-label="Next step"
          className="flex-1 rounded-md bg-stone-900 dark:bg-stone-100 px-5 py-4 text-lg text-white dark:text-stone-900 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
