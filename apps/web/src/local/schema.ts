// Local SQLite schema mirroring the Supabase Postgres schema.
//
// cr-sqlite requirement: NOT NULL columns *must* have a DEFAULT value so
// schema evolution across CRDT peers works. We keep the constraints (data
// integrity) but attach sentinel defaults that will always be overwritten
// by real inserts/upserts — they only matter for cross-peer column adds.

export const SCHEMA_VERSION = 6;

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
    shared_with_household_id text,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,

  // recipe_collections_household_idx is created in POST_SCHEMA_MIGRATIONS,
  // AFTER the shared_with_household_id backfill ALTER — deliberately not here.
  // SCHEMA_STATEMENTS runs before that ALTER, so on an existing DB whose
  // recipe_collections predates the column, creating this index throws
  // "no such column: shared_with_household_id" and aborts the whole DB init —
  // and because init dies before the ALTER, the DB can never self-heal.
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
    source_url text,           -- origin URL for video-imported recipes
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
    default_prompt text,
    key_owner_id text,
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

  // ---------- Nutrition cache (2026-06-07) ----------
  //
  // Lazy mirror of `nutrition_facts_cache`. Populated opportunistically
  // when the nutrition hook resolves a fact (either via the local-table
  // read path or the edge-function search). Not CRR — these are
  // system-wide reference rows that the server is the canonical
  // owner of; the local copy is purely an offline read cache.
  `create table if not exists nutrition_facts (
    source text not null default '',
    source_id text not null default '',
    description text not null default '',
    brand text,
    calories_kcal real,
    protein_g real,
    fat_g real,
    saturated_fat_g real,
    carbs_g real,
    sugar_g real,
    fiber_g real,
    sodium_mg real,
    portions text not null default '[]',
    fetched_at integer not null default 0,
    primary key (source, source_id)
  )`,
  `create index if not exists nutrition_facts_description_idx
    on nutrition_facts(description)`,

  // Per-user mapping mirror. The server holds owner_id NULL rows
  // (platform defaults) plus owner_id = me rows; we mirror both so
  // the resolver matches the server's user-then-platform fallback.
  `create table if not exists nutrition_mappings (
    -- '' for platform-default rows, the user's uuid otherwise.
    owner_id text not null default '',
    ingredient_key text not null default '',
    source text not null default '',
    source_id text not null default '',
    custom_grams_per_unit text not null default '{}',
    updated_at integer not null default 0,
    primary key (owner_id, ingredient_key)
  )`,
  `create index if not exists nutrition_mappings_key_idx
    on nutrition_mappings(ingredient_key)`,

  // Bulk-loaded snapshot of USDA Foundation + SR Legacy from
  // `nutrition_foods_master` on the server. Pulled once per session on
  // first boot (one-shot, not incremental — these update once or twice
  // a year). Powers offline ingredient → USDA matching: ~8k rows, ~5 MB
  // on disk. Branded stays server-only because it's 500k+ rows.
  // Not CRR — pure reference data, server is canonical.
  `create table if not exists nutrition_foods_essentials (
    source text not null default '',
    source_id text not null default '',
    data_type text not null default '',
    description text not null default '',
    brand text,
    brand_owner text,
    calories_kcal real,
    protein_g real,
    fat_g real,
    saturated_fat_g real,
    carbs_g real,
    sugar_g real,
    fiber_g real,
    sodium_mg real,
    portions text not null default '[]',
    -- Pre-lowercased "description | brand | brand_owner" blob for
    -- substring matching. ~8k rows so plain LIKE is fast enough; no
    -- need for FTS5 + triggers + content-table choreography yet.
    search_blob text not null default '',
    primary key (source, source_id)
  )`,
  `create index if not exists nutrition_foods_essentials_blob_idx
    on nutrition_foods_essentials(search_blob)`,
  `create index if not exists nutrition_foods_essentials_data_type_idx
    on nutrition_foods_essentials(data_type)`,

  // ---------- Cooking tracker (2026-06-17) ----------
  //
  // cooking_events: "I made this" (COOKED) + "make on <date>" (PLANNED).
  // CRR-replicated. recipe_id is nullable (no default) so a cooked entry
  // survives the recipe being deleted server-side (ON DELETE SET NULL) —
  // the recipe_snapshot JSON keeps it readable. shared_with_household_id
  // is a local-only marker set by the household pull (mirrors
  // recipe_collections); the server has no such column.
  `create table if not exists cooking_events (
    id text primary key not null default '',
    owner_id text not null default '',
    recipe_id text,
    status text not null default 'PLANNED',
    event_date text not null default '',     -- ISO day 'YYYY-MM-DD'
    occasion_category text,
    meal_slot text,
    occasion_note text,
    notes text,
    adjustments text not null default '[]',  -- JSON RecipeAdjustment[]
    recipe_snapshot text,                    -- JSON RecipeSnapshot or null
    photo_paths text not null default '[]',  -- JSON array of cooking-photos storage paths
    shared_with_household_id text,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,
  `create index if not exists cooking_events_owner_date_idx
    on cooking_events(owner_id, event_date)`,
  `create index if not exists cooking_events_recipe_idx on cooking_events(recipe_id)`,
  // cooking_events_household_idx is created in POST_SCHEMA_MIGRATIONS after the
  // shared_with_household_id backfill ALTER — same ordering hazard as
  // recipe_collections above (an existing pre-column table would abort init).

  // recipe_tags: per-(owner, recipe) labels, distinct from `recipes.starred`.
  // CRR-replicated. The server enforces unique(owner_id, recipe_id, label);
  // we intentionally do NOT add a local UNIQUE index (cr-sqlite only
  // supports the primary key as a uniqueness constraint) — the repository
  // makes addTag idempotent by checking for an existing row first, and the
  // push uses onConflict on the natural key.
  `create table if not exists recipe_tags (
    id text primary key not null default '',
    owner_id text not null default '',
    recipe_id text not null default '',
    label text not null default '',
    shared_with_household_id text,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,
  `create index if not exists recipe_tags_recipe_idx on recipe_tags(recipe_id)`,
  `create index if not exists recipe_tags_owner_idx on recipe_tags(owner_id)`,
  `create index if not exists recipe_tags_label_idx on recipe_tags(label)`,

  // recipe_views: LOCAL-ONLY personal browsing history. NOT CRR, never
  // synced, never shared — "your own record" stays on this device, and
  // routing the app's highest-frequency write through sync would be a
  // thundering-herd risk. Mirrors the outbox/sync_state local-only shape
  // (autoincrement int PK, no updated_at/deleted).
  `create table if not exists recipe_views (
    id integer primary key autoincrement,
    recipe_id text not null,
    viewed_at integer not null,
    source text
  )`,
  `create index if not exists recipe_views_recipe_idx on recipe_views(recipe_id, viewed_at)`,
  `create index if not exists recipe_views_recent_idx on recipe_views(viewed_at)`,

  // Sync metadata — a singleton row per logical topic holding the
  // latest-seen remote `updated_at` (ms since epoch). Local-only, not CRR.
  `create table if not exists sync_state (
    topic text primary key not null,
    high_water_mark integer not null default 0,
    -- Composite keyset cursor for the recipes topics: high_water_ts is the
    -- exact server updated_at string (sub-ms precision preserved, NOT the
    -- truncated ms in high_water_mark) and high_water_id pins the row at that
    -- timestamp. Together they let the incremental pull step past a block of
    -- rows sharing one updated_at (e.g. a bulk migration backfill) instead of
    -- re-selecting them forever via updated_at >= ms. Empty = no cursor yet.
    high_water_ts text not null default '',
    high_water_id text not null default '',
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
  'cooking_events',
  'recipe_tags',
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
  // Per-recipe origin URL for the video-import flow (2026-06-05).
  `alter table recipes add column source_url text`,
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
    default_prompt text,
    key_owner_id text,
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
  // ---------- Household sharing (2026-06-06) ----------
  // shared_with_household_id flags a collection as visible to members of
  // the given household via the server-side RLS policy. Local code reads
  // it to render the "Shared with household" badge and to gate edits
  // (members can read but not write).
  `alter table recipe_collections add column shared_with_household_id text`,
  `create index if not exists recipe_collections_household_idx
    on recipe_collections(shared_with_household_id)
    where shared_with_household_id is not null`,
  // ---------- Nutrition cache (2026-06-07) — idempotent post-schema migration ----------
  `create table if not exists nutrition_facts (
    source text not null default '',
    source_id text not null default '',
    description text not null default '',
    brand text,
    calories_kcal real,
    protein_g real,
    fat_g real,
    saturated_fat_g real,
    carbs_g real,
    sugar_g real,
    fiber_g real,
    sodium_mg real,
    portions text not null default '[]',
    fetched_at integer not null default 0,
    primary key (source, source_id)
  )`,
  `create index if not exists nutrition_facts_description_idx
    on nutrition_facts(description)`,
  `create table if not exists nutrition_mappings (
    owner_id text not null default '',
    ingredient_key text not null default '',
    source text not null default '',
    source_id text not null default '',
    custom_grams_per_unit text not null default '{}',
    updated_at integer not null default 0,
    primary key (owner_id, ingredient_key)
  )`,
  `create index if not exists nutrition_mappings_key_idx
    on nutrition_mappings(ingredient_key)`,
  // ---------- USDA essentials bulk mirror (2026-06-08) ----------
  `create table if not exists nutrition_foods_essentials (
    source text not null default '',
    source_id text not null default '',
    data_type text not null default '',
    description text not null default '',
    brand text,
    brand_owner text,
    calories_kcal real,
    protein_g real,
    fat_g real,
    saturated_fat_g real,
    carbs_g real,
    sugar_g real,
    fiber_g real,
    sodium_mg real,
    portions text not null default '[]',
    search_blob text not null default '',
    primary key (source, source_id)
  )`,
  `create index if not exists nutrition_foods_essentials_blob_idx
    on nutrition_foods_essentials(search_blob)`,
  `create index if not exists nutrition_foods_essentials_data_type_idx
    on nutrition_foods_essentials(data_type)`,
  // ---------- Cooking tracker (2026-06-17) — idempotent post-schema migration ----------
  `create table if not exists cooking_events (
    id text primary key not null default '',
    owner_id text not null default '',
    recipe_id text,
    status text not null default 'PLANNED',
    event_date text not null default '',
    occasion_category text,
    occasion_note text,
    notes text,
    adjustments text not null default '[]',
    recipe_snapshot text,
    shared_with_household_id text,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,
  `create index if not exists cooking_events_owner_date_idx
    on cooking_events(owner_id, event_date)`,
  `create index if not exists cooking_events_recipe_idx on cooking_events(recipe_id)`,
  // shared_with_household_id is in the create-table above for fresh DBs, but a
  // local DB that created cooking_events before the column existed won't gain
  // it from create-table-if-not-exists. Backfill it BEFORE the household index
  // below references it (no-op where already present).
  `alter table cooking_events add column shared_with_household_id text`,
  `create index if not exists cooking_events_household_idx
    on cooking_events(shared_with_household_id)
    where shared_with_household_id is not null`,
  `create table if not exists recipe_tags (
    id text primary key not null default '',
    owner_id text not null default '',
    recipe_id text not null default '',
    label text not null default '',
    shared_with_household_id text,
    updated_at integer not null default 0,
    deleted integer not null default 0
  )`,
  // Same backfill for recipe_tags: it has no index on the column, so an older
  // DB silently lacks it until the sync push references it — that's the iOS
  // "no such column: shared_with_household_id" on sync.
  `alter table recipe_tags add column shared_with_household_id text`,
  `create index if not exists recipe_tags_recipe_idx on recipe_tags(recipe_id)`,
  `create index if not exists recipe_tags_owner_idx on recipe_tags(owner_id)`,
  `create index if not exists recipe_tags_label_idx on recipe_tags(label)`,
  `create table if not exists recipe_views (
    id integer primary key autoincrement,
    recipe_id text not null,
    viewed_at integer not null,
    source text
  )`,
  `create index if not exists recipe_views_recipe_idx on recipe_views(recipe_id, viewed_at)`,
  `create index if not exists recipe_views_recent_idx on recipe_views(viewed_at)`,
  // Photos on cooking entries (V2). Additive for any local DB that created
  // cooking_events before this column existed; the create-table above
  // already includes it for fresh DBs.
  `alter table cooking_events add column photo_paths text not null default '[]'`,
  // Meal slot (breakfast/lunch/dinner/snack). Nullable, additive.
  `alter table cooking_events add column meal_slot text`,
  // Bulk OCR (2026-06-22): snapshot the effective prompt onto the batch so
  // the worker uses the user's / household's prompt (was always falling back
  // to the built-in RECIPE_PROMPT), and record which member's key paid when
  // the config came from a household. Both nullable + additive.
  `alter table import_batches add column default_prompt text`,
  `alter table import_batches add column key_owner_id text`,
  // Composite keyset cursor for the recipes topics (see sync_state above).
  // Additive for any local DB created before these columns existed — without
  // the backfill an older DB silently lacks them and the cursor read throws
  // "no such column" on the first incremental pull.
  `alter table sync_state add column high_water_ts text not null default ''`,
  `alter table sync_state add column high_water_id text not null default ''`,
];
