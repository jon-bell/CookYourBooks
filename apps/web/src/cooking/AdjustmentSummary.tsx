import type { RecipeAdjustment } from '@cookyourbooks/domain';
import { summarizeAdjustment } from './format.js';

/** Read-only render of a recorded structured diff. */
export function AdjustmentSummary({
  adjustments,
}: {
  adjustments: readonly RecipeAdjustment[];
}) {
  if (adjustments.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-sm text-stone-600 dark:text-stone-400">
      {adjustments.map((a, i) => (
        <li key={i} className="flex gap-1.5">
          <span aria-hidden className="text-stone-400">↪</span>
          <span>
            {summarizeAdjustment(a)}
            {a.note ? <span className="text-stone-500"> — {a.note}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
