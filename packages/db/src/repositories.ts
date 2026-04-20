import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Recipe,
  RecipeCollection,
  RecipeCollectionRepository,
  RecipeRepository,
} from '@cookyourbooks/domain';
import type { Database } from './database.types.js';
import {
  collectionToInsert,
  ingredientToInsert,
  instructionToInsert,
  recipeToInsert,
  rowToCollection,
  rowsToRecipe,
  type IngredientRow,
  type InstructionRow,
  type RecipeRow,
} from './mapping.js';

export type CookbooksClient = SupabaseClient<Database>;

function check<T>({ data, error }: { data: T | null; error: unknown }): T {
  if (error) throw error as Error;
  if (data === null) throw new Error('Expected data from Supabase query');
  return data;
}

function checkVoid({ error }: { error: unknown }): void {
  if (error) throw error as Error;
}

export class SupabaseRecipeCollectionRepository implements RecipeCollectionRepository {
  constructor(
    private readonly client: CookbooksClient,
    private readonly ownerId: string,
  ) {}

  async list(): Promise<RecipeCollection[]> {
    const { data: collections, error } = await this.client
      .from('recipe_collections')
      .select('*')
      .eq('owner_id', this.ownerId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (!collections) return [];
    if (collections.length === 0) return [];

    const ids = collections.map((c) => c.id);
    const recipesByCol = await fetchRecipesForCollections(this.client, ids);
    return collections.map((c) => rowToCollection(c, recipesByCol.get(c.id) ?? []));
  }

  async get(id: string): Promise<RecipeCollection | undefined> {
    const { data: row, error } = await this.client
      .from('recipe_collections')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return undefined;
    const recipesByCol = await fetchRecipesForCollections(this.client, [id]);
    return rowToCollection(row, recipesByCol.get(id) ?? []);
  }

  async save(collection: RecipeCollection): Promise<void> {
    const row = collectionToInsert(collection, this.ownerId);
    checkVoid(
      await this.client.from('recipe_collections').upsert(row, { onConflict: 'id' }),
    );

    // Upsert recipes, then their child rows. We do not delete recipes here —
    // removal goes through the dedicated deleteRecipe path on the recipe repo.
    for (let i = 0; i < collection.recipes.length; i += 1) {
      const recipe = collection.recipes[i]!;
      await saveRecipe(this.client, collection.id, recipe, i);
    }
  }

  async delete(id: string): Promise<void> {
    checkVoid(await this.client.from('recipe_collections').delete().eq('id', id));
  }
}

export class SupabaseRecipeRepository implements RecipeRepository {
  constructor(
    private readonly client: CookbooksClient,
    private readonly collectionId: string,
  ) {}

  async list(): Promise<Recipe[]> {
    const map = await fetchRecipesForCollections(this.client, [this.collectionId]);
    return map.get(this.collectionId) ?? [];
  }

  async get(id: string): Promise<Recipe | undefined> {
    const { data: recipe, error } = await this.client
      .from('recipes')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!recipe) return undefined;
    const [ingredients, instructions] = await Promise.all([
      this.client.from('ingredients').select('*').eq('recipe_id', id),
      this.client.from('instructions').select('*').eq('recipe_id', id),
    ]);
    return rowsToRecipe(
      recipe,
      check(ingredients) as IngredientRow[],
      check(instructions) as InstructionRow[],
    );
  }

  async save(recipe: Recipe): Promise<void> {
    await saveRecipe(this.client, this.collectionId, recipe, 0);
  }

  async delete(id: string): Promise<void> {
    checkVoid(await this.client.from('recipes').delete().eq('id', id));
  }
}

async function saveRecipe(
  client: CookbooksClient,
  collectionId: string,
  recipe: Recipe,
  sortOrder: number,
): Promise<void> {
  checkVoid(
    await client
      .from('recipes')
      .upsert(recipeToInsert(recipe, collectionId, sortOrder), { onConflict: 'id' }),
  );

  // Replace ingredients and instructions wholesale. Simpler than diffing and
  // correct for the current editor flow. CASCADE on FK handles orphans.
  checkVoid(await client.from('ingredients').delete().eq('recipe_id', recipe.id));
  checkVoid(await client.from('instructions').delete().eq('recipe_id', recipe.id));

  if (recipe.ingredients.length > 0) {
    const rows = recipe.ingredients.map((ing, i) => ingredientToInsert(ing, recipe.id, i));
    checkVoid(await client.from('ingredients').insert(rows));
  }
  if (recipe.instructions.length > 0) {
    const rows = recipe.instructions.map((step) => instructionToInsert(step, recipe.id));
    checkVoid(await client.from('instructions').insert(rows));
  }
}

async function fetchRecipesForCollections(
  client: CookbooksClient,
  collectionIds: string[],
): Promise<Map<string, Recipe[]>> {
  if (collectionIds.length === 0) return new Map();
  const [recipesRes, ingRes, stepRes] = await Promise.all([
    client
      .from('recipes')
      .select('*')
      .in('collection_id', collectionIds)
      .order('sort_order', { ascending: true }),
    client
      .from('ingredients')
      .select('*, recipes!inner(collection_id)')
      .in('recipes.collection_id', collectionIds),
    client
      .from('instructions')
      .select('*, recipes!inner(collection_id)')
      .in('recipes.collection_id', collectionIds),
  ]);

  const recipes = check(recipesRes) as RecipeRow[];
  const allIngredients = check(ingRes) as (IngredientRow & { recipes?: unknown })[];
  const allInstructions = check(stepRes) as (InstructionRow & { recipes?: unknown })[];

  const ingByRecipe = groupBy(allIngredients, (r) => r.recipe_id);
  const stepsByRecipe = groupBy(allInstructions, (r) => r.recipe_id);

  const byCollection = new Map<string, Recipe[]>();
  for (const r of recipes) {
    const built = rowsToRecipe(
      r,
      (ingByRecipe.get(r.id) ?? []) as IngredientRow[],
      (stepsByRecipe.get(r.id) ?? []) as InstructionRow[],
    );
    const list = byCollection.get(r.collection_id) ?? [];
    list.push(built);
    byCollection.set(r.collection_id, list);
  }
  return byCollection;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = out.get(k);
    if (arr) arr.push(item);
    else out.set(k, [item]);
  }
  return out;
}
