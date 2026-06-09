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
}

/**
 * A responsive grid of 3:2 cover cards, each linking to its recipe. Renders
 * items in the order given — sorting/partitioning is the caller's job (the
 * collection browser leads with covers; the Recipes page leads with most-viewed).
 * Cover-less recipes fall back to CoverImage's gradient placeholder.
 */
export function RecipeGalleryGrid({ items }: { items: readonly GalleryCard[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((r) => {
        const pages = formatPages(r.pageNumbers);
        return (
          <li
            key={r.id}
            className="relative overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900"
          >
            <Link to={`/collections/${r.collectionId}/recipes/${r.id}`} className="block">
              <CoverImage path={r.coverImagePath ?? undefined} alt={r.title} className="aspect-[3/2] w-full" />
              <div className="p-3">
                <div className="line-clamp-2 font-medium">{r.title}</div>
                {pages ? (
                  <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{pages}</div>
                ) : null}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
