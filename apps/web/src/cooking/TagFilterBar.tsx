import { useAllTags } from './queries.js';

/**
 * Reusable multi-select chip row over the tag vocabulary. Selecting tags
 * is OR semantics (a recipe matches if it carries any selected tag).
 */
export function TagFilterBar({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (label: string) => void;
}) {
  const { data: labels = [] } = useAllTags();

  if (labels.length === 0) {
    return <p className="text-sm text-stone-500">No tags yet. Add tags on a recipe to organize.</p>;
  }

  return (
    <div className="flex flex-wrap gap-1.5" data-testid="tag-filter-bar">
      {labels.map((label) => {
        const active = selected.includes(label);
        return (
          <button
            key={label}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(label)}
            className={`rounded-full px-3 py-1 text-sm ${
              active
                ? 'bg-emerald-600 text-white'
                : 'border border-stone-300 dark:border-stone-600 hover:bg-stone-100 dark:hover:bg-stone-800'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
