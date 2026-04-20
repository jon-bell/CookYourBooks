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
    await tx.exec(
      `insert into recipes
         (id, collection_id, title, servings_amount, servings_description, sort_order, updated_at, deleted)
       values (?,?,?,?,?,?,?,0)
       on conflict(id) do update set
         collection_id=excluded.collection_id,
         title=excluded.title,
         servings_amount=excluded.servings_amount,
         servings_description=excluded.servings_description,
         sort_order=excluded.sort_order,
         updated_at=excluded.updated_at,
         deleted=0`,
      [
        recipeRow.id,
        recipeRow.collection_id,
        recipeRow.title,
        recipeRow.servings_amount,
        recipeRow.servings_description,
        recipeRow.sort_order,
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
      await tx.exec(
        `insert into ingredients
           (id, recipe_id, sort_order, type, name, preparation, notes,
            quantity_type, quantity_amount, quantity_whole, quantity_numerator,
            quantity_denominator, quantity_min, quantity_max, quantity_unit)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          ing.id,
          ing.recipe_id,
          ing.sort_order,
          ing.type,
          ing.name,
          ing.preparation,
          ing.notes,
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
      await tx.exec(
        `insert into instructions (id, recipe_id, step_number, text)
         values (?,?,?,?)`,
        [step.id, step.recipe_id, step.step_number, step.text],
      );
    }
    for (const ref of refs) {
      await tx.exec(
        `insert into instruction_ingredient_refs (instruction_id, ingredient_id)
         values (?,?) on conflict do nothing`,
        [ref.instruction_id, ref.ingredient_id],
      );
    }
  });
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
      `select r.instruction_id, r.ingredient_id
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
  const recipeRow: RecipeRow = {
    ...rInsert,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    servings_amount: rInsert.servings_amount ?? null,
    servings_description: rInsert.servings_description ?? null,
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
  const refRows: InstructionRefRow[] = recipe.instructions.flatMap((s) =>
    s.ingredientRefs.map((r) => ({
      instruction_id: s.id,
      ingredient_id: r.ingredientId,
    })),
  );
  await upsertRecipeRow(recipeRow, ingRows, stepRows, refRows);
}

function tsToMs(ts: string | number | null | undefined): number {
  if (typeof ts === 'number') return ts;
  if (!ts) return now();
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : now();
}
