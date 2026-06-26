import {
  formatQuantity,
  type Ingredient,
  type Instruction,
  isMeasured,
  type ParsedRecipeDraft,
} from '@cookyourbooks/domain';
import type { ReactNode } from 'react';

import type { DiffKind, DraftPreviewHighlights } from './bakeoff.js';

function highlightClass(kind: DiffKind, side: 'left' | 'right'): string {
  if (kind === 'same') return '';
  if (kind === 'change') return 'rounded-sm bg-amber-50 dark:bg-amber-950/30';
  if (kind === 'del') return side === 'left' ? 'rounded-sm bg-red-50 dark:bg-red-950/30' : '';
  if (kind === 'add')
    return side === 'right' ? 'rounded-sm bg-emerald-50 dark:bg-emerald-950/30' : '';
  return '';
}

function wrapHighlight(
  kind: DiffKind,
  side: 'left' | 'right',
  children: ReactNode,
  testId?: string,
): ReactNode {
  const cls = highlightClass(kind, side);
  if (!cls && !testId) return children;
  return (
    <span data-diff-kind={kind !== 'same' ? kind : undefined} data-testid={testId} className={cls}>
      {children}
    </span>
  );
}

function ingredientLine(ing: Ingredient): string {
  if (isMeasured(ing)) return `${formatQuantity(ing.quantity)} ${ing.name}`;
  return `${ing.name}${ing.description ? ` (${ing.description})` : ''}`;
}

function instructionLine(step: Instruction): string {
  return step.text;
}

/**
 * Read-only recipe draft display matching the import review editor's
 * visual language (title, meta, description, ingredients, steps).
 */
export function DraftPreview({
  draft,
  highlights,
  side = 'left',
}: {
  draft: ParsedRecipeDraft;
  highlights?: DraftPreviewHighlights;
  side?: 'left' | 'right';
}) {
  const h = highlights ?? defaultHighlights(draft);

  return (
    <article className="space-y-5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-5">
      <header className="space-y-2">
        <div
          className={`block w-full text-2xl font-semibold leading-tight text-stone-900 dark:text-stone-100 ${highlightClass(h.title, side)}`}
          data-diff-kind={h.title !== 'same' ? h.title : undefined}
        >
          {draft.title ?? '(no title)'}
        </div>
        {(draft.timeEstimate || h.timeEstimate !== 'same') && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
            <span className="inline-flex items-baseline gap-1">
              <span className="text-stone-400">time</span>
              {wrapHighlight(h.timeEstimate, side, <span>{draft.timeEstimate ?? '(time)'}</span>)}
            </span>
          </div>
        )}
      </header>

      {(draft.description || h.description !== 'same') && (
        <section>
          <div
            className={`block w-full text-sm leading-relaxed text-stone-700 dark:text-stone-300 ${highlightClass(h.description, side)}`}
            data-diff-kind={h.description !== 'same' ? h.description : undefined}
          >
            {draft.description ?? '(no description)'}
          </div>
        </section>
      )}

      {draft.equipment && draft.equipment.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Equipment
          </h3>
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.equipment.map((item, i) => (
              <span
                key={`${item}-${i}`}
                className="inline-flex items-center gap-1 rounded-full bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-xs text-stone-700 dark:text-stone-300"
              >
                {item}
              </span>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Ingredients
        </h3>
        <ul className="space-y-1">
          {draft.ingredients.map((ing, i) => {
            const kind = h.ingredients[i] ?? 'same';
            return (
              <li
                key={ing.id}
                className={`flex items-baseline gap-2 text-sm leading-relaxed text-stone-800 dark:text-stone-200 ${highlightClass(kind, side)}`}
                data-diff-kind={kind !== 'same' ? kind : undefined}
                data-diff-line={ingredientLine(ing)}
              >
                <span className="inline-block min-w-[3rem] rounded-md bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-xs font-medium text-stone-700 dark:text-stone-300">
                  {isMeasured(ing) ? formatQuantity(ing.quantity) : '(no qty)'}
                </span>
                <span className="font-medium">{ing.name}</span>
                {ing.preparation && (
                  <>
                    <span className="text-stone-300">·</span>
                    <span className="text-stone-500 dark:text-stone-400">{ing.preparation}</span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Instructions
        </h3>
        <ol className="space-y-4">
          {draft.instructions.map((step, i) => {
            const kind = h.instructions[i] ?? 'same';
            return (
              <li
                key={step.id}
                className={`flex gap-3 text-sm leading-relaxed text-stone-800 dark:text-stone-200 ${highlightClass(kind, side)}`}
                data-diff-kind={kind !== 'same' ? kind : undefined}
                data-diff-line={instructionLine(step)}
              >
                <span className="w-6 shrink-0 pt-0.5 text-right text-xs font-medium text-stone-400">
                  {i + 1}.
                </span>
                <div className="flex-1 whitespace-pre-wrap">{step.text}</div>
              </li>
            );
          })}
        </ol>
      </section>
    </article>
  );
}

function defaultHighlights(draft: ParsedRecipeDraft): DraftPreviewHighlights {
  const same = (n: number): DiffKind[] => Array.from({ length: n }, () => 'same' as const);
  return {
    title: 'same',
    description: 'same',
    timeEstimate: 'same',
    ingredients: same(draft.ingredients.length),
    instructions: same(draft.instructions.length),
  };
}
