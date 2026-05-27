// Local SQLite schema mirroring the Supabase Postgres schema.
//
// cr-sqlite requirement: NOT NULL columns *must* have a DEFAULT value so
// schema evolution across CRDT peers works. We keep the constraints (data
// integrity) but attach sentinel defaults that will always be overwritten
// by real inserts/upserts — they only matter for cross-peer column adds.

export const SCHEMA_VERSION = 3;

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
    servings_amount_max real,
    sort_order integer not null default 0,
    notes text,
    parent_recipe_id text,
    description text,
    time_estimate text,
    equipment text,            -- JSON array of strings
    book_title text,
    page_numbers text,         -- JSON array of numbers
    source_image_text text,
    starred integer not null default 0,
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
    description text,
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
    text text not null default '',
    temperature_value real,
    temperature_unit text,
    sub_instructions text,    -- JSON array of strings
    simplified_steps text,    -- JSON array of {text,durationSec?,temperature?,notes?}
    notes text
  )`,

  `create index if not exists instructions_recipe_idx on instructions(recipe_id)`,

  // Step → Ingredient references. Used by the recipe detail view + cook
  // mode to highlight which ingredients a specific step consumes, and
  // (when `consumed_quantity_*` is set) how much of each.
  `create table if not exists instruction_ingredient_refs (
    instruction_id text not null default '',
    ingredient_id text not null default '',
    consumed_quantity_type text,
    consumed_quantity_amount real,
    consumed_quantity_whole integer,
    consumed_quantity_numerator integer,
    consumed_quantity_denominator integer,
    consumed_quantity_min real,
    consumed_quantity_max real,
    consumed_quantity_unit text,
    primary key (instruction_id, ingredient_id)
  )`,

  `create index if not exists iir_instruction_idx on instruction_ingredient_refs(instruction_id)`,
  `create index if not exists iir_ingredient_idx on instruction_ingredient_refs(ingredient_id)`,

  // ---------- Bulk OCR import tables ----------
  // The Edge Function worker is the canonical writer for most of these
  // columns — the client only touches its own annotation fields
  // (assignments, status transitions to REVIEWED/DISCARDED, etc).

  `create table if not exists import_batches (
    id text primary key not null default '',
    owner_id text not null default '',
    name text not null default '',
    source_kind text not null default 'IMAGES',
    target_collection_id text,
    default_model text not null default '',
    default_provider text not null default 'gemini',
    fallback_model text,
    fallback_provider text,
    recitation_policy text not null default 'ASK',
    status text not null default 'OPEN',
    total_items integer not null default 0,
    batch_kind text not null default 'STANDARD',
    is_planner integer not null default 0,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,

  `create index if not exists import_batches_owner_idx on import_batches(owner_id)`,

  `create table if not exists import_items (
    id text primary key not null default '',
    batch_id text not null default '',
    owner_id text not null default '',
    page_index integer not null default 0,
    storage_path text not null default '',
    thumb_path text,
    source_pdf_path text,
    source_pdf_page integer,
    assigned_collection_id text,
    assigned_page_number integer,
    assigned_recipe_id text,
    is_toc integer not null default 0,
    status text not null default 'PENDING',
    claim_expires_at integer not null default 0,
    attempts integer not null default 0,
    last_error text,
    parsed_drafts_json text,
    model_used text,
    prompt_tokens integer not null default 0,
    completion_tokens integer not null default 0,
    cost_usd_micros integer not null default 0,
    created_recipe_ids text not null default '[]',
    selected_variant_id text,
    needs_fallback integer not null default 0,
    extra_storage_paths text not null default '[]',
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,

  `create index if not exists import_items_batch_idx on import_items(batch_id, page_index)`,
  `create index if not exists import_items_status_idx on import_items(owner_id, status)`,

  `create table if not exists import_item_attempts (
    id text primary key not null default '',
    item_id text not null default '',
    owner_id text not null default '',
    attempt_no integer not null default 1,
    provider text not null default '',
    model text not null default '',
    raw_response_path text,
    error_kind text,
    error_message text,
    prompt_tokens integer not null default 0,
    completion_tokens integer not null default 0,
    cost_usd_micros integer not null default 0,
    latency_ms integer not null default 0,
    started_at integer not null default 0,
    finished_at integer,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,

  `create index if not exists import_item_attempts_item_idx on import_item_attempts(item_id, attempt_no)`,

  `create table if not exists import_toc_entries (
    id text primary key not null default '',
    batch_id text not null default '',
    item_id text not null default '',
    owner_id text not null default '',
    title text not null default '',
    page_number integer,
    confidence real not null default 0,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,

  `create index if not exists import_toc_entries_batch_idx on import_toc_entries(batch_id, title)`,

  // ---------- Conversion rules ----------
  // Mirrors public.conversion_rules. Owner-scoped HOUSE rules only;
  // GLOBAL defaults aren't replicated here (fetched via React Query
  // from the read-only public.global_conversions table).
  `create table if not exists conversion_rules (
    id text primary key not null default '',
    owner_id text not null default '',
    recipe_id text,
    from_unit text not null default '',
    to_unit text not null default '',
    factor real not null default 1,
    ingredient_name text,
    notes text,
    priority text not null default 'HOUSE',
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,
  `create index if not exists conversion_rules_owner_idx on conversion_rules(owner_id)`,

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
  'import_batches',
  'import_items',
  'import_item_attempts',
  'import_toc_entries',
  'conversion_rules',
  'rewrite_jobs',
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
  // OCR-surfaced metadata (2026-04-21).
  `alter table recipes add column servings_amount_max real`,
  `alter table recipes add column description text`,
  `alter table recipes add column time_estimate text`,
  `alter table recipes add column equipment text`,
  `alter table recipes add column book_title text`,
  `alter table recipes add column page_numbers text`,
  `alter table recipes add column source_image_text text`,
  `alter table ingredients add column description text`,
  `alter table instructions add column temperature_value real`,
  `alter table instructions add column temperature_unit text`,
  `alter table instructions add column sub_instructions text`,
  `alter table instructions add column notes text`,
  `alter table instruction_ingredient_refs add column consumed_quantity_type text`,
  `alter table instruction_ingredient_refs add column consumed_quantity_amount real`,
  `alter table instruction_ingredient_refs add column consumed_quantity_whole integer`,
  `alter table instruction_ingredient_refs add column consumed_quantity_numerator integer`,
  `alter table instruction_ingredient_refs add column consumed_quantity_denominator integer`,
  `alter table instruction_ingredient_refs add column consumed_quantity_min real`,
  `alter table instruction_ingredient_refs add column consumed_quantity_max real`,
  `alter table instruction_ingredient_refs add column consumed_quantity_unit text`,
  // Bulk OCR import tables. Idempotent for fresh DBs (table already
  // exists at this point) and additive for older DBs (added on first
  // upgrade boot). `create index if not exists` is safe to re-run.
  `create table if not exists import_batches (
    id text primary key not null default '',
    owner_id text not null default '',
    name text not null default '',
    source_kind text not null default 'IMAGES',
    target_collection_id text,
    default_model text not null default '',
    default_provider text not null default 'gemini',
    fallback_model text,
    fallback_provider text,
    recitation_policy text not null default 'ASK',
    status text not null default 'OPEN',
    total_items integer not null default 0,
    batch_kind text not null default 'STANDARD',
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,
  `create index if not exists import_batches_owner_idx on import_batches(owner_id)`,
  `create table if not exists import_items (
    id text primary key not null default '',
    batch_id text not null default '',
    owner_id text not null default '',
    page_index integer not null default 0,
    storage_path text not null default '',
    thumb_path text,
    source_pdf_path text,
    source_pdf_page integer,
    assigned_collection_id text,
    assigned_page_number integer,
    is_toc integer not null default 0,
    status text not null default 'PENDING',
    claim_expires_at integer not null default 0,
    attempts integer not null default 0,
    last_error text,
    parsed_drafts_json text,
    model_used text,
    prompt_tokens integer not null default 0,
    completion_tokens integer not null default 0,
    cost_usd_micros integer not null default 0,
    created_recipe_ids text not null default '[]',
    selected_variant_id text,
    needs_fallback integer not null default 0,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,
  `alter table import_items add column needs_fallback integer not null default 0`,
  `alter table import_items add column extra_storage_paths text not null default '[]'`,
  `create index if not exists import_items_batch_idx on import_items(batch_id, page_index)`,
  `create index if not exists import_items_status_idx on import_items(owner_id, status)`,
  `create table if not exists import_item_attempts (
    id text primary key not null default '',
    item_id text not null default '',
    owner_id text not null default '',
    attempt_no integer not null default 1,
    provider text not null default '',
    model text not null default '',
    raw_response_path text,
    error_kind text,
    error_message text,
    prompt_tokens integer not null default 0,
    completion_tokens integer not null default 0,
    cost_usd_micros integer not null default 0,
    latency_ms integer not null default 0,
    started_at integer not null default 0,
    finished_at integer,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,
  `create index if not exists import_item_attempts_item_idx on import_item_attempts(item_id, attempt_no)`,
  `create table if not exists import_toc_entries (
    id text primary key not null default '',
    batch_id text not null default '',
    item_id text not null default '',
    owner_id text not null default '',
    title text not null default '',
    page_number integer,
    confidence real not null default 0,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,
  `create index if not exists import_toc_entries_batch_idx on import_toc_entries(batch_id, title)`,
  `alter table import_batches add column batch_kind text not null default 'STANDARD'`,
  `alter table import_items add column selected_variant_id text`,
  // Conversion rules (HOUSE-tier mirror of public.conversion_rules).
  `create table if not exists conversion_rules (
    id text primary key not null default '',
    owner_id text not null default '',
    recipe_id text,
    from_unit text not null default '',
    to_unit text not null default '',
    factor real not null default 1,
    ingredient_name text,
    notes text,
    priority text not null default 'HOUSE',
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,
  `create index if not exists conversion_rules_owner_idx on conversion_rules(owner_id)`,
  // Free-form per-rule notes (added 2026-06-02).
  `alter table conversion_rules add column notes text`,
  // Speed Importer additions (2026-06-03):
  //  - recipes.starred: the planner queue derives from this column.
  //  - import_items.assigned_recipe_id: pre-bind a scan to an existing
  //    placeholder so the worker output updates it in place.
  //  - import_batches.is_planner: lets the planner page find its own
  //    open AWAITING_GROUPING session across app restarts.
  `alter table recipes add column starred integer not null default 0`,
  `alter table import_items add column assigned_recipe_id text`,
  `alter table import_batches add column is_planner integer not null default 0`,
  // ---------- Instruction rewriting (2026-06-04) ----------
  // simplified_steps holds the LLM-rewritten atomic steps as JSON text.
  // Nullable, so no default needed under the cr-sqlite rule (which only
  // requires defaults on NOT NULL columns).
  `alter table instructions add column simplified_steps text`,
  // rewrite_jobs mirrors the import_items claim/lease pipeline but for
  // per-recipe instruction rewrites. CRR-replicated so the queue state
  // syncs across the user's devices.
  `create table if not exists rewrite_jobs (
    id text primary key not null default '',
    owner_id text not null default '',
    recipe_id text not null default '',
    status text not null default 'PENDING',
    provider text not null default 'gemini',
    model text not null default '',
    prompt text not null default '',
    claim_expires_at integer not null default 0,
    attempts integer not null default 0,
    last_error text,
    result_json text,
    prompt_tokens integer not null default 0,
    completion_tokens integer not null default 0,
    cost_usd_micros integer not null default 0,
    latency_ms integer not null default 0,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,
  `create index if not exists rewrite_jobs_recipe_idx on rewrite_jobs(recipe_id)`,
  `create index if not exists rewrite_jobs_owner_idx on rewrite_jobs(owner_id, status)`,
  // ---------- Recipe embeddings cache (2026-06-05) ----------
  // Mirrors public.recipe_embeddings. Stored as a BLOB of packed
  // little-endian float32s (Float32Array.buffer). Local-only mirror —
  // not CRR, derived data that the worker / browser regenerate from the
  // canonical Postgres row.
  `create table if not exists recipe_embeddings (
    recipe_id text primary key not null default '',
    embedding blob not null,
    text_hash text not null default '',
    model text not null default '',
    updated_at integer not null default 0
  )`,
  `create index if not exists recipe_embeddings_updated_idx on recipe_embeddings(updated_at)`,
];
