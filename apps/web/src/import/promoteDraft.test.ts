import {
  instruction,
  type ParsedRecipeDraft,
  type RecipeCollection,
  vague,
} from '@cookyourbooks/domain';
import { describe, expect, it } from 'vitest';

import type { ImportItem } from './model.js';
import { buildRecipeFromDraft, isAutoAcceptable, resolveTargetRecipe } from './promoteDraft.js';

function makeDraft(over: Partial<ParsedRecipeDraft> = {}): ParsedRecipeDraft {
  return {
    title: 'Chocolate Cake',
    ingredients: [vague({ name: 'a' }), vague({ name: 'b' }), vague({ name: 'c' })],
    instructions: [
      instruction({ stepNumber: 1, text: 'mix', ingredientRefs: [] }),
      instruction({ stepNumber: 2, text: 'bake', ingredientRefs: [] }),
    ],
    leftover: [],
    ...over,
  };
}

type AcceptItem = Pick<ImportItem, 'status' | 'kind' | 'parsedDrafts' | 'assignedCollectionId'>;

function makeItem(over: Partial<AcceptItem> = {}): AcceptItem {
  return {
    status: 'OCR_DONE',
    kind: 'RECIPE',
    parsedDrafts: [makeDraft()],
    assignedCollectionId: null,
    ...over,
  };
}

describe('isAutoAcceptable (Conservative bar)', () => {
  const target = 'col-1';

  it('accepts a clean single-recipe page with a batch target', () => {
    expect(isAutoAcceptable(makeItem(), target)).toBe(true);
  });

  it('accepts via the item-level collection even without a batch target', () => {
    expect(isAutoAcceptable(makeItem({ assignedCollectionId: 'col-x' }), null)).toBe(true);
  });

  it('rejects when there is nowhere to put the recipe', () => {
    expect(isAutoAcceptable(makeItem(), null)).toBe(false);
  });

  it('rejects items that are not OCR_DONE', () => {
    expect(isAutoAcceptable(makeItem({ status: 'CLAIMED' }), target)).toBe(false);
    expect(isAutoAcceptable(makeItem({ status: 'REVIEWED' }), target)).toBe(false);
  });

  it('rejects table-of-contents pages', () => {
    expect(isAutoAcceptable(makeItem({ kind: 'TOC' }), target)).toBe(false);
  });

  it('rejects notes pages (they auto-file as collection notes, not recipes)', () => {
    expect(isAutoAcceptable(makeItem({ kind: 'NOTES' }), target)).toBe(false);
  });

  it('rejects pages with more than one recipe', () => {
    expect(isAutoAcceptable(makeItem({ parsedDrafts: [makeDraft(), makeDraft()] }), target)).toBe(
      false,
    );
  });

  it('rejects a missing / blank title', () => {
    expect(
      isAutoAcceptable(makeItem({ parsedDrafts: [makeDraft({ title: undefined })] }), target),
    ).toBe(false);
    expect(
      isAutoAcceptable(makeItem({ parsedDrafts: [makeDraft({ title: '   ' })] }), target),
    ).toBe(false);
  });

  it('rejects fewer than 3 ingredients', () => {
    const d = makeDraft({ ingredients: [vague({ name: 'a' }), vague({ name: 'b' })] });
    expect(isAutoAcceptable(makeItem({ parsedDrafts: [d] }), target)).toBe(false);
  });

  it('rejects fewer than 2 instructions', () => {
    const d = makeDraft({
      instructions: [instruction({ stepNumber: 1, text: 'x', ingredientRefs: [] })],
    });
    expect(isAutoAcceptable(makeItem({ parsedDrafts: [d] }), target)).toBe(false);
  });

  it('rejects when the parser left anything unplaced', () => {
    expect(
      isAutoAcceptable(
        makeItem({ parsedDrafts: [makeDraft({ leftover: ['??? 1 cup mystery'] })] }),
        target,
      ),
    ).toBe(false);
  });
});

describe('buildRecipeFromDraft', () => {
  it('falls back to the overwrite title when the draft has none', () => {
    const r = buildRecipeFromDraft(makeDraft({ title: undefined }), {
      overwriteTitle: 'Existing Title',
    });
    expect(r.title).toBe('Existing Title');
  });

  it('overwrites an existing recipe id and stamps bookTitle + pages', () => {
    const r = buildRecipeFromDraft(makeDraft(), {
      recipeId: 'recipe-9',
      collectionTitle: 'Grandma’s Book',
      pageNumbers: [42],
    });
    expect(r.id).toBe('recipe-9');
    expect(r.bookTitle).toBe('Grandma’s Book');
    expect(r.pageNumbers).toEqual([42]);
  });

  it('re-mints ingredient ids so a re-save never collides', () => {
    const draft = makeDraft();
    const a = buildRecipeFromDraft(draft);
    const b = buildRecipeFromDraft(draft);
    const aIds = a.ingredients.map((i) => i.id);
    const bIds = b.ingredients.map((i) => i.id);
    expect(aIds.some((id) => bIds.includes(id))).toBe(false);
  });

  it('sets parentRecipeId for derived recipes (Recipe Remix lineage)', () => {
    const r = buildRecipeFromDraft(makeDraft(), { parentRecipeId: 'source-recipe-7' });
    expect(r.parentRecipeId).toBe('source-recipe-7');
    // Still mints a fresh recipe id distinct from the parent.
    expect(r.id).not.toBe('source-recipe-7');
  });

  it('leaves parentRecipeId undefined for plain imports', () => {
    const r = buildRecipeFromDraft(makeDraft());
    expect(r.parentRecipeId).toBeUndefined();
  });
});

describe('resolveTargetRecipe', () => {
  const collection = {
    recipes: [
      { id: 'r-cake', title: 'Chocolate Cake' },
      { id: 'r-pie', title: 'Apple Pie' },
    ],
  } as unknown as RecipeCollection;

  it('honors a planner pre-binding above any fuzzy match', () => {
    const out = resolveTargetRecipe(
      makeDraft({ title: 'Apple Pie' }),
      { assignedRecipeId: 'r-cake' },
      collection,
    );
    expect(out.recipeId).toBe('r-cake');
  });

  it('fuzzy-matches a near-identical title (OCR casing)', () => {
    const out = resolveTargetRecipe(
      makeDraft({ title: 'chocolate cake' }),
      { assignedRecipeId: null },
      collection,
    );
    expect(out.recipeId).toBe('r-cake');
  });

  it('returns nothing when no recipe is close enough', () => {
    const out = resolveTargetRecipe(
      makeDraft({ title: 'Beef Wellington' }),
      { assignedRecipeId: null },
      collection,
    );
    expect(out.recipeId).toBeUndefined();
  });

  it('returns nothing without a collection', () => {
    expect(resolveTargetRecipe(makeDraft(), { assignedRecipeId: null }, undefined)).toEqual({});
  });
});
