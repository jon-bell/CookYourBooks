import { memo } from 'react';
import { Link } from 'react-router-dom';

import { CoverImage } from './CoverImage.js';
import { formatPages } from './SortableRecipeList.js';

/** One card in the gallery wall. The minimal shape both the per-collection
 *  browser and the library-wide Recipes page can supply without hydrating a
 *  full Recipe. */
export interface GalleryCard {
  id: string;
  title: string;
  coverImagePath?: string | null;
  pageNumbers?: readonly number[];
  collectionId: string;
  /** When set, the card shows a secondary link to the owning collection.
   *  The in-collection browser omits it — the context is already the
   *  collection. */
  collectionTitle?: string;
}

/** Memoized single card cell — prevents re-rendering unaffected cards when
 *  the parent list reference changes (e.g. after a sort or filter). */
const GalleryCardCell = memo(function GalleryCardCell({ item }: { item: GalleryCard }) {
  const pages = formatPages(item.pageNumbers);
  return (
    <li className="gallery-card relative overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
      <Link to={`/collections/${item.collectionId}/recipes/${item.id}`} className="block">
        <CoverImage
          path={item.coverImagePath ?? undefined}
          alt={item.title}
          className="aspect-[3/2] w-full"
          variant="thumb"
        />
        <div className={item.collectionTitle ? 'px-3 pt-3' : 'p-3'}>
          <div className="line-clamp-2 font-medium">{item.title}</div>
          {pages ? (
            <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{pages}</div>
          ) : null}
        </div>
      </Link>
      {/* Sibling of the recipe Link, not nested inside it — nested anchors
          are invalid HTML (same pattern as the row star in
          SortableRecipeList). */}
      {item.collectionTitle && (
        <div className="px-3 pb-3 pt-0.5">
          <Link
            to={`/collections/${item.collectionId}`}
            className="line-clamp-1 text-xs text-stone-500 underline-offset-2 hover:underline dark:text-stone-400"
          >
            {item.collectionTitle}
          </Link>
        </div>
      )}
    </li>
  );
});

/**
 * A responsive grid of 3:2 cover cards, each linking to its recipe. Renders
 * items in the order given — sorting/partitioning is the caller's job (the
 * collection browser leads with covers; the Recipes page leads with most-viewed).
 * Cover-less recipes fall back to CoverImage's gradient placeholder.
 */
export function RecipeGalleryGrid({ items }: { items: readonly GalleryCard[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((r) => (
        <GalleryCardCell key={r.id} item={r} />
      ))}
    </ul>
  );
}
