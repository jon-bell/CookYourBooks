import type {
  Recipe,
  RecipeCollection,
  RecipeCollectionRepository,
  RecipeRepository,
} from '@cookyourbooks/domain';
import {
  rowToCollection,
  rowsToRecipe,
  collectionToInsert,
  recipeToInsert,
  ingredientToInsert,
  instructionToInsert,
  instructionRefToInsert,
  type CollectionRow,
  type IngredientRow,
  type InstructionRefRow,
  type InstructionRow,
  type RecipeRow,
} from '@cookyourbooks/db';
import { getLocalDb } from './db.js';
import { enqueue } from './outbox.js';

// Milliseconds since epoch, good enough for a monotonic-ish write marker
// on the local side.
function now(): number {
  return Date.now();
}

/** Upsert a collection row directly (used by both local saves and sync pulls). */
export async function upsertCollectionRow(row: CollectionRow): Promise<void> {
  const db = await getLocalDb();
  const rowX = row as CollectionRow & {
    moderation_state?: string | null;
    moderation_reason?: string | null;
  };
  await db.exec(
    `insert into recipe_collections
       (id, owner_id, title, source_type, author, isbn, publisher, publication_year,
        description, notes, source_url, date_accessed, site_name,
        is_public, forked_from, cover_image_path,
        moderation_state, moderation_reason,
        updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     on conflict(id) do update set
       owner_id=excluded.owner_id,
       title=excluded.title,
       source_type=excluded.source_type,
       author=excluded.author,
       isbn=excluded.isbn,
       publisher=excluded.publisher,
       publication_year=excluded.publication_year,
       description=excluded.description,
       notes=excluded.notes,
       source_url=excluded.source_url,
       date_accessed=excluded.date_accessed,
       site_name=excluded.site_name,
       is_public=excluded.is_public,
       forked_from=excluded.forked_from,
       cover_image_path=excluded.cover_image_path,
       moderation_state=excluded.moderation_state,
       moderation_reason=excluded.moderation_reason,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= recipe_collections.updated_at`,
    [
      row.id,
      row.owner_id,
      row.title,
      row.source_type,
      row.author,
      row.isbn,
      row.publisher,
      row.publication_year,
      row.description,
      row.notes,
      row.source_url,
      row.date_accessed,
      row.site_name,
      row.is_public ? 1 : 0,
      row.forked_from,
      row.cover_image_path,
      rowX.moderation_state ?? 'ACTIVE',
      rowX.moderation_reason ?? null,
      tsToMs(row.updated_at),
    ],
  );
}

/** Upsert a recipe row and replace its child ingredients/instructions + step refs. */
export async function upsertRecipeRow(
  recipeRow: RecipeRow,
  ingredients: IngredientRow[],
  instructions: InstructionRow[],
  refs: InstructionRefRow[] = [],
): Promise<void> {
  const db = await getLocalDb();
  const incomingTs = tsToMs(recipeRow.updated_at);
  // Refuse to regress a fresher local row with a stale pull. Check the
  // existing row's timestamp *before* starting the tx so we don't wipe its
  // child rows only to skip the parent overwrite.
  const existing = (await db.execO<{ updated_at: number }>(
    `select updated_at from recipes where id = ?`,
    [recipeRow.id],
  )) as { updated_at: number }[];
  if (existing[0] && existing[0].updated_at > incomingTs) return;

  await db.tx(async (tx) => {
    const recipeRowX = recipeRow as RecipeRow & {
      notes?: string | null;
      parent_recipe_id?: string | null;
      servings_amount_max?: number | null;
      description?: string | null;
      time_estimate?: string | null;
      equipment?: unknown;
      book_title?: string | null;
      page_numbers?: unknown;
      source_image_text?: string | null;
    };
    // Array-ish columns live as TEXT (JSON) in SQLite; the Postgres
    // mirror uses jsonb. Accept either shape on input.
    const equipmentJson = toJsonText(recipeRowX.equipment);
    const pageNumbersJson = toJsonText(recipeRowX.page_numbers);
    await tx.exec(
      `insert into recipes
         (id, collection_id, title, servings_amount, servings_description,
          servings_amount_max, sort_order, notes, parent_recipe_id,
          description, time_estimate, equipment, book_title, page_numbers,
          source_image_text, updated_at, deleted)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
       on conflict(id) do update set
         collection_id=excluded.collection_id,
         title=excluded.title,
         servings_amount=excluded.servings_amount,
         servings_description=excluded.servings_description,
         servings_amount_max=excluded.servings_amount_max,
         sort_order=excluded.sort_order,
         notes=excluded.notes,
         parent_recipe_id=excluded.parent_recipe_id,
         description=excluded.description,
         time_estimate=excluded.time_estimate,
         equipment=excluded.equipment,
         book_title=excluded.book_title,
         page_numbers=excluded.page_numbers,
         source_image_text=excluded.source_image_text,
         updated_at=excluded.updated_at,
         deleted=0`,
      [
        recipeRow.id,
        recipeRow.collection_id,
        recipeRow.title,
        recipeRow.servings_amount,
        recipeRow.servings_description,
        recipeRowX.servings_amount_max ?? null,
        recipeRow.sort_order,
        recipeRowX.notes ?? null,
        recipeRowX.parent_recipe_id ?? null,
        recipeRowX.description ?? null,
        recipeRowX.time_estimate ?? null,
        equipmentJson,
        recipeRowX.book_title ?? null,
        pageNumbersJson,
        recipeRowX.source_image_text ?? null,
        incomingTs,
      ],
    );
    // Wipe child rows before re-inserting. Refs are identified by their
    // instruction_id, so a blanket `in (select id from instructions
    // where recipe_id = ?)` works before we drop the instructions
    // themselves.
    await tx.exec(
      `delete from instruction_ingredient_refs
       where instruction_id in (select id from instructions where recipe_id = ?)`,
      [recipeRow.id],
    );
    await tx.exec(`delete from ingredients where recipe_id = ?`, [recipeRow.id]);
    await tx.exec(`delete from instructions where recipe_id = ?`, [recipeRow.id]);
    for (const ing of ingredients) {
      const ingX = ing as IngredientRow & { description?: string | null };
      await tx.exec(
        `insert into ingredients
           (id, recipe_id, sort_order, type, name, preparation, notes, description,
            quantity_type, quantity_amount, quantity_whole, quantity_numerator,
            quantity_denominator, quantity_min, quantity_max, quantity_unit)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          ing.id,
          ing.recipe_id,
          ing.sort_order,
          ing.type,
          ing.name,
          ing.preparation,
          ing.notes,
          ingX.description ?? null,
          ing.quantity_type,
          ing.quantity_amount,
          ing.quantity_whole,
          ing.quantity_numerator,
          ing.quantity_denominator,
          ing.quantity_min,
          ing.quantity_max,
          ing.quantity_unit,
        ],
      );
    }
    for (const step of instructions) {
      const stepX = step as InstructionRow & {
        temperature_value?: number | null;
        temperature_unit?: string | null;
        sub_instructions?: unknown;
        notes?: string | null;
      };
      await tx.exec(
        `insert into instructions
           (id, recipe_id, step_number, text,
            temperature_value, temperature_unit, sub_instructions, notes)
         values (?,?,?,?,?,?,?,?)`,
        [
          step.id,
          step.recipe_id,
          step.step_number,
          step.text,
          stepX.temperature_value ?? null,
          stepX.temperature_unit ?? null,
          toJsonText(stepX.sub_instructions),
          stepX.notes ?? null,
        ],
      );
    }
    for (const ref of refs) {
      const refX = ref as InstructionRefRow & {
        consumed_quantity_type?: string | null;
        consumed_quantity_amount?: number | null;
        consumed_quantity_whole?: number | null;
        consumed_quantity_numerator?: number | null;
        consumed_quantity_denominator?: number | null;
        consumed_quantity_min?: number | null;
        consumed_quantity_max?: number | null;
        consumed_quantity_unit?: string | null;
      };
      await tx.exec(
        `insert into instruction_ingredient_refs
           (instruction_id, ingredient_id,
            consumed_quantity_type, consumed_quantity_amount,
            consumed_quantity_whole, consumed_quantity_numerator,
            consumed_quantity_denominator, consumed_quantity_min,
            consumed_quantity_max, consumed_quantity_unit)
         values (?,?,?,?,?,?,?,?,?,?) on conflict do nothing`,
        [
          ref.instruction_id,
          ref.ingredient_id,
          refX.consumed_quantity_type ?? null,
          refX.consumed_quantity_amount ?? null,
          refX.consumed_quantity_whole ?? null,
          refX.consumed_quantity_numerator ?? null,
          refX.consumed_quantity_denominator ?? null,
          refX.consumed_quantity_min ?? null,
          refX.consumed_quantity_max ?? null,
          refX.consumed_quantity_unit ?? null,
        ],
      );
    }
  });
}

/**
 * Normalize an array-ish column value to JSON text suitable for a
 * local SQLite TEXT column. Accepts an already-stringified JSON blob
 * (pass-through), a native array (JSON-encode), or null/undefined.
 */
function toJsonText(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val.length > 0 ? val : null;
  if (Array.isArray(val)) return val.length > 0 ? JSON.stringify(val) : null;
  return null;
}

export async function softDeleteCollection(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `update recipe_collections set deleted = 1, updated_at = ? where id = ?`,
    [now(), id],
  );
}

export async function softDeleteRecipe(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `update recipes set deleted = 1, updated_at = ? where id = ?`,
    [now(), id],
  );
}

export async function purgeCollection(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.tx(async (tx) => {
    const recipeIds = (await tx.execO<{ id: string }>(
      `select id from recipes where collection_id = ?`,
      [id],
    )) as { id: string }[];
    for (const r of recipeIds) {
      await tx.exec(
        `delete from instruction_ingredient_refs
         where instruction_id in (select id from instructions where recipe_id = ?)`,
        [r.id],
      );
      await tx.exec(`delete from ingredients where recipe_id = ?`, [r.id]);
      await tx.exec(`delete from instructions where recipe_id = ?`, [r.id]);
    }
    await tx.exec(`delete from recipes where collection_id = ?`, [id]);
    await tx.exec(`delete from recipe_collections where id = ?`, [id]);
  });
}

export async function purgeRecipe(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.tx(async (tx) => {
    await tx.exec(
      `delete from instruction_ingredient_refs
       where instruction_id in (select id from instructions where recipe_id = ?)`,
      [id],
    );
    await tx.exec(`delete from ingredients where recipe_id = ?`, [id]);
    await tx.exec(`delete from instructions where recipe_id = ?`, [id]);
    await tx.exec(`delete from recipes where id = ?`, [id]);
  });
}

// ------------- Domain-facing repositories -------------

export class LocalRecipeCollectionRepository implements RecipeCollectionRepository {
  constructor(private readonly ownerId: string) {}

  async list(): Promise<RecipeCollection[]> {
    const db = await getLocalDb();
    const colRows = (await db.execO<CollectionRow>(
      `select * from recipe_collections
       where owner_id = ? and deleted = 0
       order by coalesce(updated_at, 0) desc`,
      [this.ownerId],
    )) as CollectionRow[];
    return Promise.all(colRows.map((row) => hydrateCollection(row)));
  }

  async get(id: string): Promise<RecipeCollection | undefined> {
    const db = await getLocalDb();
    const rows = (await db.execO<CollectionRow>(
      `select * from recipe_collections where id = ? and deleted = 0`,
      [id],
    )) as CollectionRow[];
    const row = rows[0];
    if (!row) return undefined;
    return hydrateCollection(row);
  }

  async save(collection: RecipeCollection): Promise<void> {
    const insert = collectionToInsert(collection, this.ownerId);
    const row: CollectionRow = {
      ...insert,
      owner_id: this.ownerId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_public: insert.is_public ?? false,
      author: insert.author ?? null,
      isbn: insert.isbn ?? null,
      publisher: insert.publisher ?? null,
      publication_year: insert.publication_year ?? null,
      description: insert.description ?? null,
      notes: insert.notes ?? null,
      source_url: insert.source_url ?? null,
      date_accessed: insert.date_accessed ?? null,
      site_name: insert.site_name ?? null,
      cover_image_path: insert.cover_image_path ?? null,
      forked_from: insert.forked_from ?? null,
    } as CollectionRow;
    await upsertCollectionRow(row);

    // Also upsert all recipes the collection carries, so create flows work.
    for (let i = 0; i < collection.recipes.length; i += 1) {
      const recipe = collection.recipes[i]!;
      await saveLocalRecipe(collection.id, recipe, i);
      await enqueue({
        kind: 'recipe_save',
        entity_id: recipe.id,
        collection_id: collection.id,
      });
    }

    await enqueue({ kind: 'collection_save', entity_id: collection.id });
  }

  async delete(id: string): Promise<void> {
    await softDeleteCollection(id);
    await enqueue({ kind: 'collection_delete', entity_id: id });
  }

  /**
   * Update each recipe's `sort_order` to its position in `orderedIds`.
   * Used by the drag-and-drop reorder UI. Only touches the `recipes` row
   * — ingredients and instructions are left alone, so a reorder doesn't
   * trigger a wasteful child-row churn on the server.
   */
  async reorderRecipes(collectionId: string, orderedIds: string[]): Promise<void> {
    const db = await getLocalDb();
    const stamp = now();
    await db.tx(async (tx) => {
      for (let i = 0; i < orderedIds.length; i += 1) {
        const id = orderedIds[i]!;
        await tx.exec(
          `update recipes set sort_order = ?, updated_at = ? where id = ? and collection_id = ?`,
          [i, stamp, id, collectionId],
        );
      }
    });
    for (const id of orderedIds) {
      await enqueue({ kind: 'recipe_reorder', entity_id: id, collection_id: collectionId });
    }
  }
}

export class LocalRecipeRepository implements RecipeRepository {
  constructor(private readonly collectionId: string) {}

  async list(): Promise<Recipe[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<RecipeRow>(
      `select * from recipes where collection_id = ? and deleted = 0
       order by sort_order asc`,
      [this.collectionId],
    )) as RecipeRow[];
    return Promise.all(rows.map((r) => hydrateRecipe(r)));
  }

  async get(id: string): Promise<Recipe | undefined> {
    const db = await getLocalDb();
    const rows = (await db.execO<RecipeRow>(
      `select * from recipes where id = ? and deleted = 0`,
      [id],
    )) as RecipeRow[];
    const row = rows[0];
    if (!row) return undefined;
    return hydrateRecipe(row);
  }

  async save(recipe: Recipe): Promise<void> {
    await saveLocalRecipe(this.collectionId, recipe, 0);
    await enqueue({
      kind: 'recipe_save',
      entity_id: recipe.id,
      collection_id: this.collectionId,
    });
  }

  async delete(id: string): Promise<void> {
    await softDeleteRecipe(id);
    await enqueue({
      kind: 'recipe_delete',
      entity_id: id,
      collection_id: this.collectionId,
    });
  }
}

// ------------- helpers -------------

async function hydrateCollection(row: CollectionRow): Promise<RecipeCollection> {
  const db = await getLocalDb();
  const recipeRows = (await db.execO<RecipeRow>(
    `select * from recipes where collection_id = ? and deleted = 0 order by sort_order asc`,
    [row.id],
  )) as RecipeRow[];
  const recipes = await Promise.all(recipeRows.map(hydrateRecipe));
  return rowToCollection(row, recipes);
}

async function hydrateRecipe(row: RecipeRow): Promise<Recipe> {
  const db = await getLocalDb();
  const [ingredients, instructions, refs] = await Promise.all([
    db.execO<IngredientRow>(`select * from ingredients where recipe_id = ? order by sort_order asc`, [
      row.id,
    ]),
    db.execO<InstructionRow>(
      `select * from instructions where recipe_id = ? order by step_number asc`,
      [row.id],
    ),
    db.execO<InstructionRefRow>(
      `select r.*
       from instruction_ingredient_refs r
       join instructions i on i.id = r.instruction_id
       where i.recipe_id = ?`,
      [row.id],
    ),
  ]);
  return rowsToRecipe(
    row,
    ingredients as IngredientRow[],
    instructions as InstructionRow[],
    refs as InstructionRefRow[],
  );
}

async function saveLocalRecipe(
  collectionId: string,
  recipe: Recipe,
  sortOrder: number,
): Promise<void> {
  const rInsert = recipeToInsert(recipe, collectionId, sortOrder);
  const recipeRow = {
    ...rInsert,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as RecipeRow;
  const ingRows: IngredientRow[] = recipe.ingredients.map((ing, i) => {
    const ins = ingredientToInsert(ing, recipe.id, i);
    return { ...ins, id: ins.id! } as IngredientRow;
  });
  const stepRows: InstructionRow[] = recipe.instructions.map((s) => {
    const ins = instructionToInsert(s, recipe.id);
    return { ...ins, id: ins.id! } as InstructionRow;
  });
  const refRows: InstructionRefRow[] = recipe.instructions.flatMap((s) =>
    s.ingredientRefs.map((r) =>
      instructionRefToInsert(s.id, r.ingredientId, r.quantity) as InstructionRefRow,
    ),
  );
  await upsertRecipeRow(recipeRow, ingRows, stepRows, refRows);
}

// ------------- Lineage lookups -------------

/** Minimal info about a recipe, enough to render a "based on …" link. */
export interface RecipeSummary {
  id: string;
  title: string;
  collectionId: string;
}

/** Fetch a recipe's title + collection for a given id. Cross-collection. */
export async function getRecipeSummary(id: string): Promise<RecipeSummary | undefined> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ id: string; title: string; collection_id: string }>(
    `select id, title, collection_id from recipes where id = ? and deleted = 0`,
    [id],
  )) as { id: string; title: string; collection_id: string }[];
  const row = rows[0];
  if (!row) return undefined;
  return { id: row.id, title: row.title, collectionId: row.collection_id };
}

/** List direct adaptations of a recipe, regardless of collection. */
export async function listAdaptations(parentId: string): Promise<RecipeSummary[]> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ id: string; title: string; collection_id: string }>(
    `select id, title, collection_id from recipes
     where parent_recipe_id = ? and deleted = 0
     order by title asc`,
    [parentId],
  )) as { id: string; title: string; collection_id: string }[];
  return rows.map((r) => ({ id: r.id, title: r.title, collectionId: r.collection_id }));
}

function tsToMs(ts: string | number | null | undefined): number {
  if (typeof ts === 'number') return ts;
  if (!ts) return now();
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : now();
}
