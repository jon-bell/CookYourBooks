import {
  instruction,
  type ParsedRecipeDraft,
  type RecipeCollection,
  vague,
} from '@cookyourbooks/domain';
import { describe, expect, it } from 'vitest';

import type { ImportItem } from './model.js';
import {
  autoAcceptableDraftIndices,
  buildRecipeFromDraft,
  isDraftAutoAcceptable,
  resolveTargetRecipe,
} from './promoteDraft.js';

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

const oneStep = () => [instruction({ stepNumber: 1, text: 'combine everything', ingredientRefs: [] })];

describe('isDraftAutoAcceptable (per-draft bar)', () => {
  it('accepts a clean draft', () => {
    expect(isDraftAutoAcceptable(makeDraft())).toBe(true);
  });

  it('accepts a single-instruction assembly recipe (market bowl, simple sauce)', () => {
    expect(isDraftAutoAcceptable(makeDraft({ instructions: oneStep() }))).toBe(true);
  });

  it('holds a draft the model flagged as an incomplete page fragment', () => {
    expect(isDraftAutoAcceptable(makeDraft({ complete: false }))).toBe(false);
  });

  it('accepts when complete is true or unreported (no signal)', () => {
    expect(isDraftAutoAcceptable(makeDraft({ complete: true }))).toBe(true);
    expect(isDraftAutoAcceptable(makeDraft({ complete: undefined }))).toBe(true);
  });

  it('rejects a draft with no instructions at all', () => {
    expect(isDraftAutoAcceptable(makeDraft({ instructions: [] }))).toBe(false);
  });

  it('rejects a missing / blank title', () => {
    expect(isDraftAutoAcceptable(makeDraft({ title: undefined }))).toBe(false);
    expect(isDraftAutoAcceptable(makeDraft({ title: '   ' }))).toBe(false);
  });

  it('rejects fewer than 3 ingredients', () => {
    expect(
      isDraftAutoAcceptable(makeDraft({ ingredients: [vague({ name: 'a' }), vague({ name: 'b' })] })),
    ).toBe(false);
  });

  it('rejects when the parser left anything unplaced', () => {
    expect(isDraftAutoAcceptable(makeDraft({ leftover: ['??? 1 cup mystery'] }))).toBe(false);
  });
});

describe('autoAcceptableDraftIndices', () => {
  const target = 'col-1';

  it('accepts a clean single-recipe page with a batch target', () => {
    expect(autoAcceptableDraftIndices(makeItem(), target)).toEqual([0]);
  });

  it('accepts via the item-level collection even without a batch target', () => {
    expect(autoAcceptableDraftIndices(makeItem({ assignedCollectionId: 'col-x' }), null)).toEqual([
      0,
    ]);
  });

  it('rejects when there is nowhere to put the recipe', () => {
    expect(autoAcceptableDraftIndices(makeItem(), null)).toEqual([]);
  });

  it('rejects items that are not OCR_DONE', () => {
    expect(autoAcceptableDraftIndices(makeItem({ status: 'CLAIMED' }), target)).toEqual([]);
    expect(autoAcceptableDraftIndices(makeItem({ status: 'REVIEWED' }), target)).toEqual([]);
  });

  it('rejects table-of-contents pages', () => {
    expect(autoAcceptableDraftIndices(makeItem({ kind: 'TOC' }), target)).toEqual([]);
  });

  it('rejects notes pages (they auto-file as collection notes, not recipes)', () => {
    expect(autoAcceptableDraftIndices(makeItem({ kind: 'NOTES' }), target)).toEqual([]);
  });

  it('accepts every clean recipe on a multi-recipe page', () => {
    const item = makeItem({ parsedDrafts: [makeDraft(), makeDraft(), makeDraft()] });
    expect(autoAcceptableDraftIndices(item, target)).toEqual([0, 1, 2]);
  });

  it('takes only the clean drafts on a mixed page, leaving weak ones for review', () => {
    const item = makeItem({
      parsedDrafts: [
        makeDraft(), // clean
        makeDraft({ leftover: ['??? mystery'] }), // weak
        makeDraft(), // clean
      ],
    });
    expect(autoAcceptableDraftIndices(item, target)).toEqual([0, 2]);
  });

  it('returns nothing when no draft on the page clears the bar', () => {
    const item = makeItem({
      parsedDrafts: [makeDraft({ title: undefined }), makeDraft({ instructions: [] })],
    });
    expect(autoAcceptableDraftIndices(item, target)).toEqual([]);
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
