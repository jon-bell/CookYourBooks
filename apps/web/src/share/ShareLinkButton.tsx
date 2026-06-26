import { useToast } from '../components/ToastProvider.js';
import {
  SHARE_AUDIENCE_MESSAGE,
  SHARE_AUDIENCE_TONE,
  type ShareAudience,
} from './shareAudience.js';
import { bareRecipeShareUrl, copyToClipboard } from './shareUrl.js';

/**
 * Copies the recipe's bare-uuid share link (/r/<id>) and pops a toast that
 * reminds the user who can actually open it — public collection, household
 * library sharing, or just themselves. Rendered on every recipe (unlike the
 * old CopyLinkButton, which only appeared once the collection was public).
 */
export function ShareLinkButton({
  recipeId,
  audience,
}: {
  recipeId: string;
  audience: ShareAudience;
}) {
  const { showToast } = useToast();

  async function onClick() {
    const ok = await copyToClipboard(bareRecipeShareUrl(recipeId));
    if (!ok) {
      showToast('Copy failed — your browser blocked clipboard access.', 'warn');
      return;
    }
    showToast(SHARE_AUDIENCE_MESSAGE[audience], SHARE_AUDIENCE_TONE[audience], 5000);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="share-link-button"
      className="rounded-md px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
    >
      Share link
    </button>
  );
}
