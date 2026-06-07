import { useState } from 'react';
import type { Recipe, RecipeAdjustment } from '@cookyourbooks/domain';

type AdjustmentKind = RecipeAdjustment['type'];

const KIND_OPTIONS: { value: AdjustmentKind; label: string }[] = [
  { value: 'INGREDIENT_SWAP', label: 'Swap an ingredient' },
  { value: 'INGREDIENT_OMIT', label: 'Leave out an ingredient' },
  { value: 'INGREDIENT_ADD', label: 'Add an ingredient' },
  { value: 'INSTRUCTION_SWAP', label: 'Do a step differently' },
  { value: 'INSTRUCTION_SKIP', label: 'Skip a step' },
];

const inputCls =
  'rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-2 py-1 text-sm';

/**
 * Controlled editor for the structured recipe diff on a cook log. Reads
 * the recipe's current ingredients / instructions to populate the "from"
 * selects, and snapshots their human labels into the produced adjustment
 * so the record stays legible if the recipe later changes.
 */
export function AdjustmentsEditor({
  recipe,
  value,
  onChange,
}: {
  recipe: Recipe;
  value: RecipeAdjustment[];
  onChange: (next: RecipeAdjustment[]) => void;
}) {
  const [kind, setKind] = useState<AdjustmentKind>('INGREDIENT_SWAP');

  function add() {
    onChange([...value, blankAdjustment(kind, recipe)]);
  }
  function update(index: number, next: RecipeAdjustment) {
    onChange(value.map((a, i) => (i === index ? next : a)));
  }
  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3">
      {value.map((adj, i) => (
        <div
          key={i}
          className="rounded-md border border-stone-200 dark:border-stone-700 p-2 space-y-2"
          data-testid="adjustment-row"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-stone-500">
              {KIND_OPTIONS.find((k) => k.value === adj.type)?.label}
            </span>
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-xs text-stone-500 hover:text-red-600"
              aria-label="Remove change"
            >
              Remove
            </button>
          </div>
          <AdjustmentFields recipe={recipe} adj={adj} onChange={(n) => update(i, n)} />
        </div>
      ))}

      <div className="flex items-center gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as AdjustmentKind)}
          className={inputCls}
          aria-label="Type of change"
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={add}
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          + Add change
        </button>
      </div>
    </div>
  );
}

function blankAdjustment(kind: AdjustmentKind, recipe: Recipe): RecipeAdjustment {
  const firstIng = recipe.ingredients[0];
  const firstStep = recipe.instructions[0];
  switch (kind) {
    case 'INGREDIENT_SWAP':
      return {
        type: 'INGREDIENT_SWAP',
        ingredientId: firstIng?.id ?? '',
        fromName: firstIng?.name ?? '',
        toText: '',
      };
    case 'INGREDIENT_OMIT':
      return {
        type: 'INGREDIENT_OMIT',
        ingredientId: firstIng?.id ?? '',
        fromName: firstIng?.name ?? '',
      };
    case 'INGREDIENT_ADD':
      return { type: 'INGREDIENT_ADD', toText: '' };
    case 'INSTRUCTION_SWAP':
      return {
        type: 'INSTRUCTION_SWAP',
        instructionId: firstStep?.id ?? '',
        stepNumber: firstStep?.stepNumber ?? 1,
        fromText: firstStep?.text ?? '',
        toText: '',
      };
    case 'INSTRUCTION_SKIP':
      return {
        type: 'INSTRUCTION_SKIP',
        instructionId: firstStep?.id ?? '',
        stepNumber: firstStep?.stepNumber ?? 1,
        fromText: firstStep?.text ?? '',
      };
  }
}

function AdjustmentFields({
  recipe,
  adj,
  onChange,
}: {
  recipe: Recipe;
  adj: RecipeAdjustment;
  onChange: (next: RecipeAdjustment) => void;
}) {
  function ingredientSelect(selectedId: string, onPick: (id: string, name: string) => void) {
    return (
      <select
        value={selectedId}
        onChange={(e) => {
          const ing = recipe.ingredients.find((x) => x.id === e.target.value);
          onPick(e.target.value, ing?.name ?? '');
        }}
        className={inputCls}
        aria-label="Ingredient"
      >
        {recipe.ingredients.map((ing) => (
          <option key={ing.id} value={ing.id}>
            {ing.name}
          </option>
        ))}
      </select>
    );
  }

  function stepSelect(selectedId: string, onPick: (id: string, num: number, text: string) => void) {
    return (
      <select
        value={selectedId}
        onChange={(e) => {
          const step = recipe.instructions.find((x) => x.id === e.target.value);
          onPick(e.target.value, step?.stepNumber ?? 1, step?.text ?? '');
        }}
        className={inputCls}
        aria-label="Step"
      >
        {recipe.instructions.map((step) => (
          <option key={step.id} value={step.id}>
            Step {step.stepNumber}
          </option>
        ))}
      </select>
    );
  }

  switch (adj.type) {
    case 'INGREDIENT_SWAP':
      return (
        <div className="flex flex-wrap items-center gap-2">
          {ingredientSelect(adj.ingredientId, (id, name) =>
            onChange({ ...adj, ingredientId: id, fromName: name }),
          )}
          <span aria-hidden>→</span>
          <input
            type="text"
            value={adj.toText}
            placeholder="used instead…"
            onChange={(e) => onChange({ ...adj, toText: e.target.value })}
            className={inputCls}
            aria-label="Replacement"
          />
        </div>
      );
    case 'INGREDIENT_OMIT':
      return ingredientSelect(adj.ingredientId, (id, name) =>
        onChange({ ...adj, ingredientId: id, fromName: name }),
      );
    case 'INGREDIENT_ADD':
      return (
        <input
          type="text"
          value={adj.toText}
          placeholder="added ingredient…"
          onChange={(e) => onChange({ ...adj, toText: e.target.value })}
          className={inputCls}
          aria-label="Added ingredient"
        />
      );
    case 'INSTRUCTION_SWAP':
      return (
        <div className="flex flex-wrap items-center gap-2">
          {stepSelect(adj.instructionId, (id, num, text) =>
            onChange({ ...adj, instructionId: id, stepNumber: num, fromText: text }),
          )}
          <input
            type="text"
            value={adj.toText}
            placeholder="did this instead…"
            onChange={(e) => onChange({ ...adj, toText: e.target.value })}
            className={inputCls}
            aria-label="Replacement step"
          />
        </div>
      );
    case 'INSTRUCTION_SKIP':
      return stepSelect(adj.instructionId, (id, num, text) =>
        onChange({ ...adj, instructionId: id, stepNumber: num, fromText: text }),
      );
  }
}
