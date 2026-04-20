// Local SQLite schema mirroring the Supabase Postgres schema.
//
// cr-sqlite requirement: NOT NULL columns *must* have a DEFAULT value so
// schema evolution across CRDT peers works. We keep the constraints (data
// integrity) but attach sentinel defaults that will always be overwritten
// by real inserts/upserts — they only matter for cross-peer column adds.

export const SCHEMA_VERSION = 1;

export const SCHEMA_STATEMENTS: string[] = [
  `create table if not exists recipe_collections (
    id text primary key not null default '',
    owner_id text not null default '',
    title text not null default '',
    source_type text not null default 'PERSONAL',
    author text,
    isbn text,
    publisher text,
    publication_year integer,
    description text,
    notes text,
    source_url text,
    date_accessed text,
    site_name text,
    is_public integer not null default 0,
    forked_from text,
    cover_image_path text,
    moderation_state text not null default 'ACTIVE',
    moderation_reason text,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,

  `create table if not exists recipes (
    id text primary key not null default '',
    collection_id text not null default '',
    title text not null default '',
    servings_amount real,
    servings_description text,
    sort_order integer not null default 0,
    notes text,
    parent_recipe_id text,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,

  `create index if not exists recipes_collection_idx
    on recipes(collection_id)`,

  `create index if not exists recipes_parent_idx
    on recipes(parent_recipe_id)`,

  `create table if not exists ingredients (
    id text primary key not null default '',
    recipe_id text not null default '',
    sort_order integer not null default 0,
    type text not null default 'MEASURED',
    name text not null default '',
    preparation text,
    notes text,
    quantity_type text,
    quantity_amount real,
    quantity_whole integer,
    quantity_numerator integer,
    quantity_denominator integer,
    quantity_min real,
    quantity_max real,
    quantity_unit text
  )`,

  `create index if not exists ingredients_recipe_idx on ingredients(recipe_id)`,

  `create table if not exists instructions (
    id text primary key not null default '',
    recipe_id text not null default '',
    step_number integer not null default 0,
    text text not null default ''
  )`,

  `create index if not exists instructions_recipe_idx on instructions(recipe_id)`,

  // Step → Ingredient references. Used by the recipe detail view + cook
  // mode to highlight which ingredients a specific step consumes.
  `create table if not exists instruction_ingredient_refs (
    instruction_id text not null default '',
    ingredient_id text not null default '',
    primary key (instruction_id, ingredient_id)
  )`,

  `create index if not exists iir_instruction_idx on instruction_ingredient_refs(instruction_id)`,
  `create index if not exists iir_ingredient_idx on instruction_ingredient_refs(ingredient_id)`,

  // Sync metadata — a singleton row per logical topic holding the
  // latest-seen remote `updated_at` (ms since epoch). Local-only, not CRR.
  `create table if not exists sync_state (
    topic text primary key not null,
    high_water_mark integer not null default 0,
    last_error text
  )`,

  // Outbox: local writes still to push upstream. Local-only, not CRR.
  `create table if not exists outbox (
    id integer primary key autoincrement,
    kind text not null,
    entity_id text not null,
    collection_id text,
    enqueued_at integer not null,
    attempts integer not null default 0,
    last_error text
  )`,
];

// Tables to mark as conflict-free replicated relations.
export const CRR_TABLES = [
  'recipe_collections',
  'recipes',
  'ingredients',
  'instructions',
  'instruction_ingredient_refs',
];

// Idempotent post-schema migrations. Appended to over time as columns
// get added. SQLite's `ALTER TABLE ADD COLUMN` can't take `IF NOT EXISTS`,
// so the caller in `db.ts` swallows duplicate-column errors.
export const POST_SCHEMA_MIGRATIONS: string[] = [
  `alter table recipe_collections add column moderation_state text not null default 'ACTIVE'`,
  `alter table recipe_collections add column moderation_reason text`,
  `alter table recipes add column notes text`,
  `alter table recipes add column parent_recipe_id text`,
  `create index if not exists recipes_parent_idx on recipes(parent_recipe_id)`,
];
