import { useState } from 'react';
import { shareRecipeSocialCard } from './socialCard.js';
import { recipeShareUrl } from './shareUrl.js';

/**
 * Overlay button for a gallery card: shares the recipe as a composed "social
 * card" image (cover + title) via the platform share sheet. Lives as a sibling
 * of the card's <Link> (not nested) and stops click propagation so tapping it
 * never navigates to the recipe.
 */
export function ShareCardButton({
  collectionId,
  recipeId,
  title,
  coverImagePath,
  className,
}: {
  collectionId: string;
  recipeId: string;
  title: string;
  coverImagePath?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await shareRecipeSocialCard({
        title,
        coverImagePath,
        url: recipeShareUrl(collectionId, recipeId),
      });
    } catch {
      // Composition/share failures shouldn't surface as a crash; the user can
      // retry or share from the recipe page.
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={`Share ${title}`}
      title="Share"
      className={
        className ??
        'absolute right-2 top-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition hover:bg-black/65 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50'
      }
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[18px] w-[18px]"
        aria-hidden="true"
      >
        <path d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" />
      </svg>
    </button>
  );
}
