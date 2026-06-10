import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { formatQuantity, formatServings, isMeasured, type Quantity, type Recipe } from '@cookyourbooks/domain';
import { CoverImage } from '../components/CoverImage.js';

/** The slice of collection metadata the presentational recipe body needs —
 *  satisfied by both the local domain RecipeCollection and the remote
 *  shared-recipe fetch. */
export interface RecipeBodyCollectionMeta {
  title: string;
  sourceType: string;
  author?: string | null;
  siteName?: string | null;
}

/**
 * Presentational recipe header: cover, title, byline, book/page line, source
 * link, servings, time, headnote, equipment. Extracted from RecipePage so the
 * public share view renders the identical layout (including the mobile
 * overflow fixes). Owner-only extras (scan link, parent link, tag editor)
 * slot in via `children`, rendered between the source line and servings.
 */
export function RecipeHeaderMeta({
  recipe,
  collection,
  isAdaptation = false,
  children,
  coverSlot,
  collectionHref,
}: {
  /** Pass the scaled recipe so servings reflect the current scale. */
  recipe: Recipe;
  collection?: RecipeBodyCollectionMeta;
  /** Suppresses the "Headnote from …" caption (adaptations aren't quotes). */
  isAdaptation?: boolean;
  children?: ReactNode;
  /** Overrides the default read-only cover. Owner pages pass an editable
   *  cover component; the public share view passes nothing. */
  coverSlot?: ReactNode;
  /** When set, the book/collection title line links here (the owner view
   *  passes the collection route; the public share view passes nothing —
   *  anonymous viewers can't open the collection). */
  collectionHref?: string;
}) {
  return (
    <>
      {coverSlot !== undefined
        ? coverSlot
        : recipe.coverImagePath && (
            <CoverImage
              path={recipe.coverImagePath}
              alt={`${recipe.title} cover`}
              className="mt-3 h-48 w-full max-w-md rounded-lg border border-stone-200 dark:border-stone-700"
            />
          )}
      <h1 className="mt-1 break-words text-3xl font-semibold">{recipe.title}</h1>
      {collection?.sourceType === 'PUBLISHED_BOOK' && collection.author && (
        <p className="mt-1 text-base text-stone-600 dark:text-stone-400">
          by{' '}
          <span className="font-medium text-stone-900 dark:text-stone-100">
            {collection.author}
          </span>
        </p>
      )}
      {collection?.sourceType === 'WEBSITE' && collection.siteName && (
        <p className="mt-1 text-base text-stone-600 dark:text-stone-400">
          from{' '}
          <span className="font-medium text-stone-900 dark:text-stone-100">
            {collection.siteName}
          </span>
        </p>
      )}
      {(recipe.bookTitle || (recipe.pageNumbers && recipe.pageNumbers.length > 0)) && (
        <p className="mt-1 break-words text-sm text-stone-500 dark:text-stone-400">
          {recipe.bookTitle && collectionHref ? (
            <Link to={collectionHref} className="underline-offset-2 hover:underline">
              {recipe.bookTitle}
            </Link>
          ) : (
            recipe.bookTitle
          )}
          {recipe.bookTitle && recipe.pageNumbers && recipe.pageNumbers.length > 0 ? ' · ' : ''}
          {recipe.pageNumbers && recipe.pageNumbers.length > 0
            ? `p. ${recipe.pageNumbers.join(', ')}`
            : ''}
        </p>
      )}
      {recipe.sourceUrl && (
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          <a
            href={recipe.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="break-all underline-offset-2 hover:underline"
          >
            ▶ Watch the source video
          </a>
        </p>
      )}
      {children}
      {recipe.servings && (
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          Serves {formatServings(recipe.servings)}
        </p>
      )}
      {recipe.timeEstimate && (
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">⏲ {recipe.timeEstimate}</p>
      )}
      {recipe.description && (
        <figure className="mt-4 border-l-2 border-stone-300 dark:border-stone-600 pl-3">
          {!isAdaptation && collection?.sourceType === 'PUBLISHED_BOOK' && (
            <figcaption className="text-[11px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Headnote{collection.author ? ` from ${collection.author}` : ' from the original recipe'}
            </figcaption>
          )}
          {!isAdaptation && collection?.sourceType === 'WEBSITE' && (
            <figcaption className="text-[11px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
              From {collection.siteName ?? 'the original source'}
            </figcaption>
          )}
          <blockquote className="whitespace-pre-wrap break-words text-stone-700 dark:text-stone-300 italic">
            {recipe.description}
          </blockquote>
        </figure>
      )}
      {recipe.equipment && recipe.equipment.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5 text-xs">
          {recipe.equipment.map((item) => (
            <li
              key={item}
              className="break-words rounded-full bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-stone-700 dark:text-stone-300"
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The ingredients + instructions grid and the notes card. Mobile-safe by
 * construction: grid/flex children carry min-w-0 and user content wraps with
 * break-words, so an unbreakable token (long URL, pasted ingredient) can
 * never push the page wider than the viewport. `textScale` applies CSS zoom
 * (which reflows, unlike transform) for the recipe-page text-size control.
 */
export function RecipeContentGrid({
  recipe,
  displayQuantity = (q) => formatQuantity(q),
  textScale = 1,
}: {
  /** Pass the scaled recipe. */
  recipe: Recipe;
  displayQuantity?: (q: Quantity, ingredientName: string) => string;
  textScale?: number;
}) {
  return (
    <div style={textScale !== 1 ? { zoom: textScale } : undefined} className="space-y-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <section className="md:col-span-1 min-w-0 space-y-2">
          <h2 className="text-lg font-semibold">Ingredients</h2>
          <ul className="space-y-1.5" data-testid="ingredient-list">
            {recipe.ingredients.map((ing) => (
              <li key={ing.id} className="break-words text-sm">
                {isMeasured(ing) ? (
                  <>
                    <span className="font-medium">
                      {displayQuantity(ing.quantity, ing.name)}
                    </span>{' '}
                    {ing.name}
                    {ing.preparation && (
                      <span className="text-stone-500 dark:text-stone-400">, {ing.preparation}</span>
                    )}
                  </>
                ) : (
                  <>
                    {ing.name}
                    {ing.preparation && (
                      <span className="text-stone-500 dark:text-stone-400">, {ing.preparation}</span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="md:col-span-2 min-w-0 space-y-2">
          <h2 className="text-lg font-semibold">Instructions</h2>
          <ol className="space-y-3">
            {recipe.instructions.map((step) => (
              <li key={step.id} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-900 dark:bg-stone-100 text-xs font-medium text-white dark:text-stone-900">
                  {step.stepNumber}
                </span>
                <div className="min-w-0 flex-1 break-words">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span>{step.text}</span>
                    {step.temperature && (
                      <span className="rounded-full bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-xs text-amber-900 dark:text-amber-200 ring-1 ring-amber-200">
                        {step.temperature.value}°
                        {step.temperature.unit === 'FAHRENHEIT' ? 'F' : 'C'}
                      </span>
                    )}
                  </div>
                  {step.subInstructions && step.subInstructions.length > 0 && (
                    <ul className="mt-1 ml-4 list-disc space-y-0.5 text-sm text-stone-600 dark:text-stone-400">
                      {step.subInstructions.map((sub, i) => (
                        <li key={i}>{sub}</li>
                      ))}
                    </ul>
                  )}
                  {step.simplifiedSteps && step.simplifiedSteps.length > 0 && (
                    <details className="mt-2" data-testid="simplified-preview">
                      <summary className="cursor-pointer text-xs text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200">
                        Simplified steps for Cook Mode
                      </summary>
                      <ul className="mt-1 ml-4 list-decimal space-y-0.5 text-sm text-stone-600 dark:text-stone-400">
                        {step.simplifiedSteps.map((ss, i) => (
                          <li key={i}>
                            {ss.text}
                            {ss.durationSec != null && (
                              <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                {formatDuration(ss.durationSec)}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {step.notes && (
                    <p className="mt-1 text-xs italic text-stone-500 dark:text-stone-400">{step.notes}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {recipe.notes && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/40 p-4">
          <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Notes</h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-stone-700 dark:text-stone-300">{recipe.notes}</p>
        </section>
      )}
    </div>
  );
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
