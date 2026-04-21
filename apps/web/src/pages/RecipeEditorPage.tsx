import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  createRecipe,
  instruction,
  measured,
  vague,
  exact,
  parseIngredientLine,
  servings as makeServings,
  Units,
  isMeasured,
  type Ingredient,
  type Instruction,
  type ParsedRecipeDraft,
  type Quantity,
  type Recipe,
} from '@cookyourbooks/domain';
import { useCollection, useSaveRecipe } from '../data/queries.js';

type IngredientDraft = {
  id: string;
  kind: 'MEASURED' | 'VAGUE';
  name: string;
  preparation: string;
  amount: string;
  unit: string;
};

type InstructionDraft = {
  id: string;
  text: string;
  /** Ingredient ids this step uses. Surfaces in cook mode. */
  refIds: string[];
};

export function RecipeEditorPage({ mode }: { mode: 'create' | 'edit' }) {
  const { collectionId, recipeId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: collection } = useCollection(collectionId);
  const saveRecipe = useSaveRecipe(collectionId ?? '');

  const existing =
    mode === 'edit' ? collection?.recipes.find((r) => r.id === recipeId) : undefined;

  // In `create` mode the caller (e.g. the Import-from-photo flow) can pass a
  // {@link ParsedRecipeDraft} in the navigation state to seed the form.
  const seedDraft =
    mode === 'create'
      ? ((location.state as { draft?: ParsedRecipeDraft } | null)?.draft ?? undefined)
      : undefined;

  const [title, setTitle] = useState(existing?.title ?? seedDraft?.title ?? '');
  const [servingsAmount, setServingsAmount] = useState<string>(
    existing?.servings?.amount
      ? String(existing.servings.amount)
      : seedDraft?.servings?.amount
        ? String(seedDraft.servings.amount)
        : '',
  );
  const [servingsDesc, setServingsDesc] = useState(
    existing?.servings?.description ?? seedDraft?.servings?.description ?? '',
  );

  const initialIngredients: IngredientDraft[] = useMemo(() => {
    if (existing) return existing.ingredients.map(toDraft);
    if (seedDraft && seedDraft.ingredients.length > 0)
      return seedDraft.ingredients.map(toDraft);
    return [newIngredientDraft()];
  }, [existing, seedDraft]);
  const [ingredients, setIngredients] = useState<IngredientDraft[]>(initialIngredients);
  useEffect(() => setIngredients(initialIngredients), [initialIngredients]);

  const initialInstructions: InstructionDraft[] = useMemo(() => {
    if (existing)
      return existing.instructions.map((s) => ({
        id: s.id,
        text: s.text,
        refIds: s.ingredientRefs.map((r) => r.ingredientId),
      }));
    if (seedDraft && seedDraft.instructions.length > 0)
      return seedDraft.instructions.map((s) => ({
        id: s.id,
        text: s.text,
        refIds: s.ingredientRefs.map((r) => r.ingredientId),
      }));
    return [{ id: crypto.randomUUID(), text: '', refIds: [] }];
  }, [existing, seedDraft]);
  const [instructions, setInstructions] = useState<InstructionDraft[]>(initialInstructions);
  useEffect(() => setInstructions(initialInstructions), [initialInstructions]);

  const [bulkPaste, setBulkPaste] = useState('');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  useEffect(() => setNotes(existing?.notes ?? ''), [existing?.notes]);

  useEffect(() => {
    if (mode === 'edit' && collection && !existing) navigate(`/collections/${collectionId}`);
  }, [mode, collection, existing, collectionId, navigate]);

  if (!collection) return <p className="text-stone-500">Loading…</p>;

  // The "source" recipe supplies metadata the editor doesn't currently
  // surface but must preserve round-trip: per-step consumed quantities,
  // temperatures, sub-instructions, per-step notes, vague-ingredient
  // descriptions, book/page provenance, etc. Either an existing recipe
  // being edited, or the OCR draft being seeded — both shapes carry
  // the fields we need.
  const source = existing ?? seedDraft;

  async function save() {
    if (!title.trim()) return;
    const sourceIngredientsById = new Map(
      (source?.ingredients ?? []).map((ing) => [ing.id, ing]),
    );
    const builtIngredients: Ingredient[] = ingredients
      .filter((d) => d.name.trim())
      .map((d) => preservingIngredient(fromDraft(d), sourceIngredientsById.get(d.id)));
    // Only keep ref ids that point at ingredients we're actually saving.
    // Protects against stale ids referring to ingredients the user deleted.
    const surviving = new Set(builtIngredients.map((ing) => ing.id));
    const sourceStepsById = new Map((source?.instructions ?? []).map((s) => [s.id, s]));
    const builtInstructions: Instruction[] = instructions
      .filter((d) => d.text.trim())
      .map((d, i) => {
        const src = sourceStepsById.get(d.id);
        const refsBySource = new Map(
          (src?.ingredientRefs ?? []).map((r) => [r.ingredientId, r]),
        );
        return instruction({
          id: d.id,
          stepNumber: i + 1,
          text: d.text.trim(),
          ingredientRefs: d.refIds
            .filter((id) => surviving.has(id))
            .map((ingredientId) => ({
              ingredientId,
              quantity: refsBySource.get(ingredientId)?.quantity,
            })),
          temperature: src?.temperature,
          subInstructions: src?.subInstructions,
          notes: src?.notes,
        });
      });
    const servingsNum = servingsAmount ? Number(servingsAmount) : undefined;
    const servingsMax =
      existing?.servings?.amountMax ?? seedDraft?.servings?.amountMax;
    const recipe: Recipe = createRecipe({
      id: existing?.id,
      title: title.trim(),
      servings:
        servingsNum && Number.isFinite(servingsNum) && servingsNum > 0
          ? makeServings(
              servingsNum,
              servingsDesc.trim() || undefined,
              // Preserve a range-style yield only when the upper bound
              // is still compatible with the user-entered amount.
              servingsMax !== undefined && servingsMax >= servingsNum
                ? servingsMax
                : undefined,
            )
          : undefined,
      ingredients: builtIngredients,
      instructions: builtInstructions,
      notes: notes.trim() || undefined,
      // Preserve the adaptation link across edits — the editor should
      // never drop lineage metadata just because it wasn't surfaced in
      // the form.
      parentRecipeId: existing?.parentRecipeId,
      // Rich OCR-surfaced metadata: keep it so cookbook provenance,
      // equipment, descriptions, and raw OCR text survive a round trip
      // through the editor even though the form doesn't surface them.
      description: existing?.description ?? seedDraft?.description,
      timeEstimate: existing?.timeEstimate ?? seedDraft?.timeEstimate,
      equipment: existing?.equipment ?? seedDraft?.equipment,
      bookTitle: existing?.bookTitle ?? seedDraft?.bookTitle,
      pageNumbers: existing?.pageNumbers ?? seedDraft?.pageNumbers,
      sourceImageText: existing?.sourceImageText ?? seedDraft?.sourceImageText,
    });
    await saveRecipe.mutateAsync(recipe);
    navigate(`/collections/${collection!.id}/recipes/${recipe.id}`);
  }

  function preservingIngredient(ing: Ingredient, src: Ingredient | undefined): Ingredient {
    // The editor doesn't let the user type a "to taste" qualifier yet,
    // but we shouldn't drop it on round-trip. Only applies to VAGUE.
    if (ing.type === 'VAGUE' && src && src.type === 'VAGUE' && src.description) {
      return { ...ing, description: src.description };
    }
    return ing;
  }

  function handleBulkPaste() {
    const lines = bulkPaste.split('\n').map((l) => l.trim()).filter(Boolean);
    const parsed: IngredientDraft[] = [];
    for (const line of lines) {
      const ing = parseIngredientLine(line);
      if (ing) parsed.push(toDraft(ing));
    }
    if (parsed.length) {
      setIngredients((cur) => {
        const nonEmpty = cur.filter((d) => d.name.trim());
        return [...nonEmpty, ...parsed];
      });
      setBulkPaste('');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">
        {mode === 'edit' ? 'Edit recipe' : 'New recipe'}
      </h1>
      <section className="space-y-3">
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded border border-stone-300 px-3 py-2"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Servings">
            <input
              type="number"
              min={0}
              step={1}
              value={servingsAmount}
              onChange={(e) => setServingsAmount(e.target.value)}
              className="w-full rounded border border-stone-300 px-3 py-2"
            />
          </Field>
          <Field label="Description (optional)">
            <input
              value={servingsDesc}
              onChange={(e) => setServingsDesc(e.target.value)}
              placeholder="cookies, bowls, …"
              className="w-full rounded border border-stone-300 px-3 py-2"
            />
          </Field>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Ingredients</h2>
          <button
            onClick={() => setIngredients((cur) => [...cur, newIngredientDraft()])}
            className="text-sm text-stone-700 hover:underline"
          >
            + Add ingredient
          </button>
        </div>
        <div className="rounded-lg border border-stone-200 bg-white">
          <ul className="divide-y divide-stone-200">
            {ingredients.map((d, idx) => (
              <li key={d.id} className="p-3">
                <IngredientRow
                  draft={d}
                  onChange={(next) =>
                    setIngredients((cur) => cur.map((x, i) => (i === idx ? next : x)))
                  }
                  onRemove={() =>
                    setIngredients((cur) => cur.filter((_, i) => i !== idx))
                  }
                />
              </li>
            ))}
          </ul>
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-stone-600">Paste ingredients from text</summary>
          <div className="mt-2 space-y-2">
            <textarea
              value={bulkPaste}
              onChange={(e) => setBulkPaste(e.target.value)}
              rows={5}
              placeholder={`2 cups flour\n1 tsp salt\nsalt to taste`}
              className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-xs"
            />
            <button
              onClick={handleBulkPaste}
              className="rounded-md bg-stone-900 px-3 py-1.5 text-xs text-white hover:bg-stone-800"
            >
              Parse and add
            </button>
          </div>
        </details>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Instructions</h2>
          <button
            onClick={() =>
              setInstructions((cur) => [
                ...cur,
                { id: crypto.randomUUID(), text: '', refIds: [] },
              ])
            }
            className="text-sm text-stone-700 hover:underline"
          >
            + Add step
          </button>
        </div>
        <ol className="space-y-3">
          {instructions.map((d, idx) => (
            <li key={d.id} className="space-y-2 rounded-lg border border-stone-200 bg-white p-3">
              <div className="flex gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-200 text-sm">
                  {idx + 1}
                </span>
                <textarea
                  value={d.text}
                  onChange={(e) =>
                    setInstructions((cur) =>
                      cur.map((x, i) => (i === idx ? { ...x, text: e.target.value } : x)),
                    )
                  }
                  rows={2}
                  className="flex-1 rounded border border-stone-300 px-3 py-2 text-sm"
                />
                <button
                  onClick={() => setInstructions((cur) => cur.filter((_, i) => i !== idx))}
                  className="text-xs text-stone-500 hover:text-red-700"
                  aria-label={`Remove step ${idx + 1}`}
                >
                  Remove
                </button>
              </div>
              {ingredients.some((ing) => ing.name.trim()) && (
                <fieldset className="pl-10">
                  <legend className="sr-only">Ingredients used in step {idx + 1}</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {ingredients
                      .filter((ing) => ing.name.trim())
                      .map((ing) => {
                        const selected = d.refIds.includes(ing.id);
                        return (
                          <button
                            key={ing.id}
                            type="button"
                            onClick={() =>
                              setInstructions((cur) =>
                                cur.map((x, i) =>
                                  i === idx
                                    ? {
                                        ...x,
                                        refIds: selected
                                          ? x.refIds.filter((id) => id !== ing.id)
                                          : [...x.refIds, ing.id],
                                      }
                                    : x,
                                ),
                              )
                            }
                            aria-pressed={selected}
                            className={`rounded-full border px-2 py-0.5 text-xs transition ${
                              selected
                                ? 'border-stone-900 bg-stone-900 text-white'
                                : 'border-stone-300 bg-stone-50 text-stone-700 hover:border-stone-400'
                            }`}
                          >
                            {ing.name || '(unnamed)'}
                          </button>
                        );
                      })}
                  </div>
                </fieldset>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-2">
        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="What worked, what to change next time, substitutions…"
            className="w-full rounded border border-stone-300 px-3 py-2 text-sm"
          />
        </Field>
      </section>

      {saveRecipe.isError && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {(saveRecipe.error as Error).message}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={save}
          disabled={saveRecipe.isPending}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
        >
          {saveRecipe.isPending ? 'Saving…' : 'Save recipe'}
        </button>
        <button
          onClick={() => navigate(-1)}
          className="rounded-md px-4 py-2 text-sm text-stone-600 hover:text-stone-900"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function IngredientRow({
  draft,
  onChange,
  onRemove,
}: {
  draft: IngredientDraft;
  onChange: (next: IngredientDraft) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={draft.kind}
        onChange={(e) => onChange({ ...draft, kind: e.target.value as IngredientDraft['kind'] })}
        className="rounded border border-stone-300 px-2 py-1 text-sm"
      >
        <option value="MEASURED">Measured</option>
        <option value="VAGUE">To taste</option>
      </select>
      {draft.kind === 'MEASURED' && (
        <>
          <input
            type="number"
            step="any"
            min={0}
            value={draft.amount}
            onChange={(e) => onChange({ ...draft, amount: e.target.value })}
            placeholder="amount"
            className="w-24 rounded border border-stone-300 px-2 py-1 text-sm"
          />
          <select
            value={draft.unit}
            onChange={(e) => onChange({ ...draft, unit: e.target.value })}
            className="rounded border border-stone-300 px-2 py-1 text-sm"
          >
            {Object.values(Units).map((u) => (
              <option key={u.name} value={u.name}>
                {u.name}
              </option>
            ))}
          </select>
        </>
      )}
      <input
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
        placeholder="ingredient name"
        className="flex-1 min-w-[160px] rounded border border-stone-300 px-2 py-1 text-sm"
      />
      <input
        value={draft.preparation}
        onChange={(e) => onChange({ ...draft, preparation: e.target.value })}
        placeholder="preparation (optional)"
        className="w-48 rounded border border-stone-300 px-2 py-1 text-sm"
      />
      <button
        onClick={onRemove}
        type="button"
        aria-label={`Remove ingredient ${draft.name || 'row'}`}
        className="ml-auto rounded-md px-2 py-1 text-xs text-stone-500 hover:bg-red-50 hover:text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
      >
        Remove
      </button>
    </div>
  );
}

function newIngredientDraft(): IngredientDraft {
  return {
    id: crypto.randomUUID(),
    kind: 'MEASURED',
    name: '',
    preparation: '',
    amount: '',
    unit: Units.CUP.name,
  };
}

function toDraft(ing: Ingredient): IngredientDraft {
  if (isMeasured(ing)) {
    const { amount, unit } = flattenQuantity(ing.quantity);
    return {
      id: ing.id,
      kind: 'MEASURED',
      name: ing.name,
      preparation: ing.preparation ?? '',
      amount: String(amount),
      unit,
    };
  }
  return {
    id: ing.id,
    kind: 'VAGUE',
    name: ing.name,
    preparation: ing.preparation ?? '',
    amount: '',
    unit: '',
  };
}

function fromDraft(d: IngredientDraft): Ingredient {
  if (d.kind === 'MEASURED') {
    const amount = Number(d.amount);
    const safe = Number.isFinite(amount) && amount > 0 ? amount : 0;
    return measured({
      id: d.id,
      name: d.name.trim(),
      preparation: d.preparation.trim() || undefined,
      quantity: exact(safe, d.unit),
    });
  }
  return vague({
    id: d.id,
    name: d.name.trim(),
    preparation: d.preparation.trim() || undefined,
  });
}

function flattenQuantity(q: Quantity): { amount: number; unit: string } {
  switch (q.type) {
    case 'EXACT':
      return { amount: q.amount, unit: q.unit };
    case 'FRACTIONAL':
      return { amount: q.whole + q.numerator / q.denominator, unit: q.unit };
    case 'RANGE':
      return { amount: (q.min + q.max) / 2, unit: q.unit };
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
      {children}
    </label>
  );
}
