import { describe, expect, it } from 'vitest';

import { measured, vague } from '../src/model/ingredient.js';
import { exact } from '../src/model/quantity.js';
import { createRecipe } from '../src/model/recipe.js';
import {
  buildRecipeEmbedText,
  EMBEDDING_DIM,
  EMBEDDING_MODEL_ID,
  EMBEDDING_STORED_MODEL,
  hashEmbedText,
} from '../src/services/embeddingModel.js';

describe('embedding model constants', () => {
  it('matches the dimension of the chosen model', () => {
    expect(EMBEDDING_MODEL_ID).toBe('Xenova/gte-small');
    expect(EMBEDDING_STORED_MODEL).toBe('gte-small');
    expect(EMBEDDING_DIM).toBe(384);
  });
});

describe('buildRecipeEmbedText', () => {
  it('includes title, description, ingredients, notes, book title, equipment', () => {
    const recipe = createRecipe({
      title: 'Lemon Vinaigrette',
      description: 'A bright dressing for green salads',
      ingredients: [
        measured({ name: 'olive oil', quantity: exact(0.5, 'cup') }),
        vague({ name: 'lemon juice', description: 'fresh-squeezed' }),
      ],
      notes: 'tastes better after resting 10 minutes',
      bookTitle: 'Salt Fat Acid Heat',
      equipment: ['whisk', 'small bowl'],
    });
    const text = buildRecipeEmbedText(recipe);
    expect(text).toContain('Lemon Vinaigrette');
    expect(text).toContain('bright dressing');
    expect(text).toContain('olive oil');
    expect(text).toContain('lemon juice');
    expect(text).toContain('fresh-squeezed');
    expect(text).toContain('tastes better after resting');
    expect(text).toContain('Salt Fat Acid Heat');
    expect(text).toContain('whisk, small bowl');
  });

  it('omits instruction text even when present', () => {
    const recipe = createRecipe({
      title: 'Bread',
      ingredients: [vague({ name: 'flour' })],
      instructions: [
        { id: 'i1', stepNumber: 1, text: 'Knead vigorously for ten minutes', ingredientRefs: [] },
      ],
    });
    expect(buildRecipeEmbedText(recipe)).not.toContain('Knead vigorously');
  });

  it('handles missing optional fields', () => {
    const recipe = createRecipe({ title: 'Toast', ingredients: [vague({ name: 'bread' })] });
    const text = buildRecipeEmbedText(recipe);
    expect(text).toBe('Title: Toast\nIngredients: bread');
  });

  it('is stable: same input produces the same output', () => {
    const r1 = createRecipe({
      title: 'Aioli',
      ingredients: [vague({ name: 'garlic' }), vague({ name: 'egg yolk' })],
    });
    const r2 = createRecipe({
      title: 'Aioli',
      ingredients: [vague({ name: 'garlic' }), vague({ name: 'egg yolk' })],
    });
    expect(buildRecipeEmbedText(r1)).toBe(buildRecipeEmbedText(r2));
  });

  it('hashEmbedText produces stable hex SHA-256 digests', async () => {
    const a = await hashEmbedText('hello world');
    const b = await hashEmbedText('hello world');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const c = await hashEmbedText('hello world!');
    expect(c).not.toBe(a);
  });
});
