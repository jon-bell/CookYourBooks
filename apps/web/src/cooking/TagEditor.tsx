import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { normalizeLabel } from '@cookyourbooks/domain';
import { useAddRecipeTag, useAllTags, useRecipeTags, useRemoveRecipeTag } from './queries.js';

/**
 * Tag chips + add input on a recipe. Distinct from the `starred` flag —
 * a general organizing tool. Suggests existing labels (the user's tag
 * vocabulary) to discourage near-duplicate typos. Each chip links to the
 * tag-browse view.
 */
export function TagEditor({ recipeId }: { recipeId: string }) {
  const { data: tags = [] } = useRecipeTags(recipeId);
  const { data: allLabels = [] } = useAllTags();
  const addTag = useAddRecipeTag();
  const removeTag = useRemoveRecipeTag();
  const [input, setInput] = useState('');

  const suggestions = useMemo(() => {
    const typed = normalizeLabel(input);
    if (!typed) return [];
    return allLabels
      .filter((l) => l.includes(typed) && !tags.includes(l))
      .slice(0, 6);
  }, [input, allLabels, tags]);

  function commit(label: string) {
    const normalized = normalizeLabel(label);
    if (!normalized) return;
    addTag.mutate({ recipeId, label: normalized });
    setInput('');
  }

  return (
    <div className="mt-3" data-testid="tag-editor">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((label) => (
          <span
            key={label}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/50 px-2 py-0.5 text-xs text-emerald-800 dark:text-emerald-200"
          >
            <Link to={`/tags/${encodeURIComponent(label)}`} className="hover:underline">
              {label}
            </Link>
            <button
              type="button"
              aria-label={`Remove tag ${label}`}
              onClick={() => removeTag.mutate({ recipeId, label })}
              className="text-emerald-600 hover:text-red-600"
            >
              ×
            </button>
          </span>
        ))}

        <span className="relative">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit(input);
              }
            }}
            placeholder="+ tag"
            aria-label="Add a tag"
            data-testid="tag-input"
            className="w-24 rounded-full border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-2 py-0.5 text-xs focus:w-40"
          />
          {suggestions.length > 0 && (
            <ul className="absolute left-0 top-full z-10 mt-1 min-w-32 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 py-1 shadow-lg">
              {suggestions.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => commit(s)}
                    className="block w-full px-3 py-1 text-left text-xs hover:bg-stone-100 dark:hover:bg-stone-800"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </span>
      </div>
    </div>
  );
}
