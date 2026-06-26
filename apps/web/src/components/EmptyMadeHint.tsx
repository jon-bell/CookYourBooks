/**
 * Shown when a "Recently made" sort is selected but nothing has been cooked
 * yet — otherwise the list order silently doesn't change and the sort looks
 * broken. Rendered above the (title-ordered) list, not instead of it.
 */
export function EmptyMadeHint() {
  return (
    <p
      data-testid="empty-made-hint"
      className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 py-3 text-sm text-stone-500 dark:text-stone-400"
    >
      Nothing made yet — log a cook with “I made this” from a recipe page to see your most recent
      dishes first.
    </p>
  );
}
