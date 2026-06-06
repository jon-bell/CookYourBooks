import {
  instruction,
  isMeasured,
  measured,
  vague,
  type Ingredient,
  type Instruction,
  type ParsedRecipeDraft,
} from '@cookyourbooks/domain';

/**
 * Clone a draft's ingredients + instructions with fresh ids and remap
 * step→ingredient refs through the id map. Without this, promoting a
 * draft to a real recipe collides on the global UNIQUE(ingredients.id)
 * any time the user retries a save, or two drafts shared an id.
 *
 * Shared by the OCR import-item save path and the video-link import flow.
 */
export function withFreshIds(
  draft: ParsedRecipeDraft,
): { ingredients: Ingredient[]; instructions: Instruction[] } {
  const idMap = new Map<string, string>();
  const ingredients: Ingredient[] = draft.ingredients.map((ing) => {
    const newId = crypto.randomUUID();
    idMap.set(ing.id, newId);
    if (isMeasured(ing)) {
      return measured({
        id: newId,
        name: ing.name,
        preparation: ing.preparation,
        notes: ing.notes,
        quantity: ing.quantity,
      });
    }
    return vague({
      id: newId,
      name: ing.name,
      preparation: ing.preparation,
      notes: ing.notes,
      description: ing.description,
    });
  });
  const instructions: Instruction[] = draft.instructions.map((step, i) =>
    instruction({
      id: crypto.randomUUID(),
      stepNumber: i + 1,
      text: step.text,
      ingredientRefs: step.ingredientRefs
        .map((ref) => {
          const nextId = idMap.get(ref.ingredientId);
          if (!nextId) return undefined;
          return { ingredientId: nextId, quantity: ref.quantity };
        })
        .filter(
          (r): r is { ingredientId: string; quantity: (typeof step.ingredientRefs)[number]['quantity'] } =>
            r !== undefined,
        ),
      temperature: step.temperature,
      subInstructions: step.subInstructions,
      notes: step.notes,
    }),
  );
  return { ingredients, instructions };
}
