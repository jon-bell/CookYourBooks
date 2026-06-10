import { describe, expect, it } from 'vitest';
import { fetchSharedRecipe } from '../src/sharedRecipe.js';
import type { CookbooksClient } from '../src/repositories.js';

// Minimal chainable PostgREST stub: routes a from(table) chain to a canned
// result regardless of the filters applied. Enough to exercise the mapping
// and null-handling without a live Supabase.
type Result = { data: unknown; error: null };

function stubClient(tables: Record<string, unknown>): CookbooksClient {
  const chain = (table: string) => {
    const result: Result = { data: tables[table] ?? null, error: null };
    const listResult: Result = { data: tables[table] ?? [], error: null };
    const c = {
      select: () => c,
      eq: () => c,
      in: () => Promise.resolve(listResult),
      maybeSingle: () => Promise.resolve(result),
      then: (resolve: (v: Result) => unknown) => Promise.resolve(listResult).then(resolve),
    };
    return c;
  };
  return { from: chain } as unknown as CookbooksClient;
}

const RECIPE_ROW = {
  id: 'r1',
  collection_id: 'c1',
  title: 'Shared Soup',
  servings_amount: 4,
  servings_description: null,
  notes: 'season well',
  parent_recipe_id: null,
  sort_order: 0,
  created_at: '',
  updated_at: '',
};

const INGREDIENT_ROWS = [
  {
    id: 'i1',
    recipe_id: 'r1',
    kind: 'VAGUE',
    name: 'salt',
    preparation: null,
    notes: null,
    quantity_type: null,
    sort_order: 0,
  },
];

const INSTRUCTION_ROWS = [
  { id: 's1', recipe_id: 'r1', step_number: 1, text: 'Simmer.', sort_order: 0 },
];

const COLLECTION_META = {
  id: 'c1',
  title: 'Public Book',
  source_type: 'PUBLISHED_BOOK',
  author: 'A. Chef',
  site_name: null,
  is_public: true,
};

describe('fetchSharedRecipe', () => {
  it('maps the full graph through rowsToRecipe with collection meta', async () => {
    const client = stubClient({
      recipes: RECIPE_ROW,
      ingredients: INGREDIENT_ROWS,
      instructions: INSTRUCTION_ROWS,
      recipe_collections: COLLECTION_META,
      instruction_ingredient_refs: [],
    });
    const result = await fetchSharedRecipe(client, 'r1');
    expect(result).not.toBeNull();
    expect(result!.recipe.title).toBe('Shared Soup');
    expect(result!.recipe.ingredients).toHaveLength(1);
    expect(result!.recipe.ingredients[0]!.name).toBe('salt');
    expect(result!.recipe.instructions[0]!.text).toBe('Simmer.');
    expect(result!.collection).toEqual({
      id: 'c1',
      title: 'Public Book',
      sourceType: 'PUBLISHED_BOOK',
      author: 'A. Chef',
      siteName: null,
      isPublic: true,
    });
  });

  it('returns null when the recipe row is RLS-filtered or missing', async () => {
    const client = stubClient({});
    expect(await fetchSharedRecipe(client, 'nope')).toBeNull();
  });

  it('tolerates a filtered collection row (renders without breadcrumb)', async () => {
    const client = stubClient({
      recipes: RECIPE_ROW,
      ingredients: [],
      instructions: [],
      recipe_collections: null,
    });
    const result = await fetchSharedRecipe(client, 'r1');
    expect(result!.collection).toBeNull();
    expect(result!.recipe.ingredients).toHaveLength(0);
  });
});
