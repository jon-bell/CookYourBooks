import { describe, expect, it } from 'vitest';
import {
  createPersonalCollection,
  createRecipe,
  exact,
  fractional,
  instruction,
  measured,
  servings,
  vague,
  isMeasured,
} from '@cookyourbooks/domain';
import {
  collectionToInsert,
  ingredientToInsert,
  instructionToInsert,
  recipeToInsert,
  rowToCollection,
  rowsToRecipe,
  type CollectionRow,
  type IngredientRow,
  type InstructionRow,
  type RecipeRow,
} from '../src/mapping.js';

const OWNER = '00000000-0000-0000-0000-0000000000aa';

describe('collection mapping', () => {
  it('round-trips a personal collection', () => {
    const c = createPersonalCollection({
      id: 'col-1',
      title: 'My Greens',
      description: 'Salads and bowls',
      isPublic: true,
    });
    const insert = collectionToInsert(c, OWNER);
    const row: CollectionRow = {
      ...insert,
      owner_id: OWNER,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      is_public: insert.is_public ?? false,
      author: null,
      isbn: null,
      publisher: null,
      publication_year: null,
      source_url: null,
      date_accessed: null,
      site_name: null,
      notes: null,
      cover_image_path: insert.cover_image_path ?? null,
      forked_from: insert.forked_from ?? null,
      description: insert.description ?? null,
    } as CollectionRow;
    const back = rowToCollection(row, []);
    expect(back.id).toBe('col-1');
    expect(back.sourceType).toBe('PERSONAL');
    expect(back.isPublic).toBe(true);
    if (back.sourceType === 'PERSONAL') {
      expect(back.description).toBe('Salads and bowls');
    }
  });
});

describe('recipe mapping', () => {
  it('round-trips a recipe through insert/rows', () => {
    const recipe = createRecipe({
      id: 'r-1',
      title: 'Test',
      servings: servings(4, 'bowls'),
      ingredients: [
        measured({ id: 'i-1', name: 'flour', quantity: exact(2, 'cup'), preparation: 'sifted' }),
        measured({ id: 'i-2', name: 'butter', quantity: fractional(0, 1, 2, 'cup') }),
        vague({ id: 'i-3', name: 'salt' }),
      ],
      instructions: [
        instruction({ id: 's-1', stepNumber: 1, text: 'Mix.' }),
        instruction({ id: 's-2', stepNumber: 2, text: 'Bake.' }),
      ],
    });

    const recipeRow: RecipeRow = {
      ...recipeToInsert(recipe, 'col-1', 0),
      created_at: '',
      updated_at: '',
      servings_amount: recipe.servings!.amount,
      servings_description: recipe.servings!.description ?? null,
    } as RecipeRow;
    const ingRows: IngredientRow[] = recipe.ingredients.map((ing, i) => {
      const ins = ingredientToInsert(ing, recipe.id, i);
      return {
        id: ins.id!,
        recipe_id: ins.recipe_id,
        sort_order: ins.sort_order,
        type: ins.type,
        name: ins.name,
        preparation: ins.preparation ?? null,
        notes: ins.notes ?? null,
        quantity_type: ins.quantity_type ?? null,
        quantity_amount: ins.quantity_amount ?? null,
        quantity_whole: ins.quantity_whole ?? null,
        quantity_numerator: ins.quantity_numerator ?? null,
        quantity_denominator: ins.quantity_denominator ?? null,
        quantity_min: ins.quantity_min ?? null,
        quantity_max: ins.quantity_max ?? null,
        quantity_unit: ins.quantity_unit ?? null,
      } as IngredientRow;
    });
    const stepRows: InstructionRow[] = recipe.instructions.map((s) => {
      const ins = instructionToInsert(s, recipe.id);
      return {
        id: ins.id!,
        recipe_id: ins.recipe_id,
        step_number: ins.step_number,
        text: ins.text,
      };
    });

    const back = rowsToRecipe(recipeRow, ingRows, stepRows);
    expect(back.title).toBe('Test');
    expect(back.servings?.amount).toBe(4);
    expect(back.ingredients).toHaveLength(3);

    const first = back.ingredients[0]!;
    expect(isMeasured(first)).toBe(true);
    if (isMeasured(first)) {
      expect(first.quantity).toEqual({ type: 'EXACT', amount: 2, unit: 'cup' });
      expect(first.preparation).toBe('sifted');
    }
    const second = back.ingredients[1]!;
    if (isMeasured(second)) {
      expect(second.quantity).toEqual({
        type: 'FRACTIONAL',
        whole: 0,
        numerator: 1,
        denominator: 2,
        unit: 'cup',
      });
    }
    expect(back.ingredients[2]?.type).toBe('VAGUE');
    expect(back.instructions).toHaveLength(2);
    expect(back.instructions[0]?.text).toBe('Mix.');
  });

  it('treats malformed measured rows as vague (data integrity fallback)', () => {
    const recipeRow: RecipeRow = {
      id: 'r-2',
      collection_id: 'c',
      title: 't',
      servings_amount: null,
      servings_description: null,
      sort_order: 0,
      notes: null,
      parent_recipe_id: null,
      created_at: '',
      updated_at: '',
    };
    const badIng: IngredientRow = {
      id: 'i',
      recipe_id: 'r-2',
      sort_order: 0,
      type: 'MEASURED',
      name: 'mystery',
      preparation: null,
      notes: null,
      quantity_type: 'EXACT',
      quantity_amount: null, // malformed
      quantity_whole: null,
      quantity_numerator: null,
      quantity_denominator: null,
      quantity_min: null,
      quantity_max: null,
      quantity_unit: 'cup',
    };
    const back = rowsToRecipe(recipeRow, [badIng], []);
    expect(back.ingredients[0]?.type).toBe('VAGUE');
  });
});
