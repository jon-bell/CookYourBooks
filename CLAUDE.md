# CookYourBooks

A cross-platform recipe management app. React web + Capacitor mobile (iOS/Android). Supabase backend with offline-first sync.

## Project structure

```
cookyourbooks/
├── packages/
│   ├── domain/         # Pure TypeScript domain model (no framework deps)
│   └── db/             # Supabase repository adapters + generated types
├── apps/
│   └── web/            # Vite web app
├── supabase/           # Migrations, RPC functions, RLS policies, seed data
├── PLAN.md             # Full product plan, architecture, schema, phases
└── CLAUDE.md           # This file
```

`packages/ui` and `apps/mobile` are planned but not yet created.

## Key architecture decisions

- **Local-first via cr-sqlite:** The source of truth for reads is a browser-resident SQLite database built on `@vlcn.io/crsqlite-wasm`, persisted to IndexedDB. Every page reads via `LocalRecipeRepository` / `LocalRecipeCollectionRepository` in `apps/web/src/local/repositories.ts`. Writes hit local first, then queue into `outbox` for background push to Supabase.
- **Sync engine** (`apps/web/src/local/sync.ts`):
  - **Pull:** On login and on every realtime event, fetch rows `updated_at > watermark` from `recipe_collections`, `recipes`, `ingredients`, `instructions` and upsert into local. Watermarks live in the local `sync_state` table, keyed by topic.
  - **Push:** Drains the `outbox` table in FIFO order, stopping on first failure so the retry schedule (user re-activates sync or comes back online) can recover cleanly. Strips `created_at` / `updated_at` from push payloads — the Postgres trigger owns those.
  - **Realtime:** Subscribes to `postgres_changes` on the four CRR tables (RLS-filtered). Realtime events upsert into local and invalidate React Query.
- **cr-sqlite requirements:** Every CRR table must have a `PRIMARY KEY NOT NULL` and every `NOT NULL` column must carry a `DEFAULT`. Don't CRR the local-only `outbox` or `sync_state` tables. See `apps/web/src/local/schema.ts`.
- **CRDT at the edges:** cr-sqlite gives column-level LWW merge semantics among SQLite peers. Since Supabase Postgres is not a cr-sqlite peer, merges across the sync boundary are row-level LWW (driven by Postgres `updated_at`). This matches PLAN.md's stated "LWW per field".
- **Domain purity:** `packages/domain` has zero framework dependencies — pure TypeScript types, conversion logic, recipe service, parsing, and export. Testable in isolation.
- **Repository pattern:** `RecipeRepository` / `RecipeCollectionRepository` interfaces live in `packages/domain`. The Supabase-talking adapters in `packages/db` are used *only* by the sync engine; UI code never talks to them directly.
- **Auth:** `apps/web/src/auth/AuthProvider.tsx` holds the session. Email/password + Google OAuth. `SyncProvider` boots the local DB and kicks off the first pull when a session appears.
- **No Edge Functions, with one exception:** All backend logic uses Supabase views (`public_collections`), RLS policies, and Postgres RPC functions (`fork_collection`). PostgREST handles queries directly. Forks are pulled into the local cache via `syncNow()` after the RPC returns. The narrow exception is `import-worker`: the bulk OCR pipeline (see `supabase/migrations/20260522000000_imports.sql`) is a long async job that calls a third-party LLM with the user's key — running it from the browser would block, retry poorly, and leak the API key, so it's an Edge Function that reads keys from Vault under the service role.
- **IDs:** Domain factories mint UUIDs via `crypto.randomUUID()` so they round-trip through Postgres `uuid` columns unchanged.
- **OCR import:** `apps/web/src/import/ocr.ts` calls a multimodal LLM (Gemini or any OpenAI-compatible vision model) to convert a photo straight into JSON matching our domain shape. The validator in `apps/web/src/import/llm.ts` is tolerant — malformed ingredients fall into `leftover` instead of throwing. Settings (provider / key / model / prompt) live in `localStorage` under `cookyourbooks.ocr.v1` and never sync through Supabase. Tests override via `window.__cybOcrShim`.
- **Mobile:** `apps/mobile` is a Capacitor shell over `apps/web/dist`. Native surfaces are camera (`@capacitor/camera`) and haptics (`@capacitor/haptics`). Both code paths live in `apps/web` and feature-detect Capacitor at runtime, so no code forks by platform. The iOS native project (`apps/mobile/ios/`) is committed; release flow is fastlane-driven from `apps/mobile/ios/fastlane/` (`fastlane beta` → TestFlight, `fastlane release` → App Store). Bundle ID `app.cookyourbooks`, team `YNDYJ3A9CQ`, signing material in the private `jon-bell/cookyourbooks-certs` repo via `fastlane match`. See `apps/mobile/README.md` for the full workflow.
- **Keyboard shortcuts:** `apps/web/src/keyboard/shortcuts.ts` binds `/`, `n`, `e`, `c`, `?`, and `g l`/`g d`/`g s` chords. The global listener ignores keystrokes originating inside `input`/`textarea`/`contenteditable`.
- **Semantic search:** `/search` runs cosine similarity in JS over locally-cached recipe vectors. Model is **`gte-small` (384d)**, run two ways that produce cosine-comparable vectors: the browser loads `Xenova/gte-small` via `@huggingface/transformers` (lazy on first visit, ~30 MB weights cached in IndexedDB), and the Edge Function worker uses the runtime-native `Supabase.ai.Session('gte-small')` (transformers.js has no working ONNX backend in the edge runtime). `packages/domain/src/services/embeddingModel.ts` splits `EMBEDDING_MODEL_ID` (the browser HF loader id) from `EMBEDDING_STORED_MODEL` (`'gte-small'`, the value written to / compared in `recipe_embeddings.model`) and holds the shared text-builder + SHA-256. Vectors live canonically in `public.recipe_embeddings` (pgvector) and mirror to local SQLite as packed `Float32Array` BLOBs (`recipe_embeddings` table, not CRR). On recipe save the browser embeds locally and pushes via `embed_upsert_client` (outbox `embedding_push` kind); database triggers also enqueue `recipe_embedding_jobs` which the import-worker drains with `runEmbedLoop`. **Household-shared recipes are searchable too:** `recipe_embeddings` carries the same denormalized `owner_id`/`household_id` as the other shared tables (`20260624000000`, trigger-stamped from the parent recipe, refreshed by `refresh_household_denorm`) and the same claim-based read policy, so co-members' vectors pull into the local mirror (`household_id = <jwt claim> and owner_id <> me`, in `pullHouseholdSharedContent`) and `listSearchableEmbeddings` includes them via the collection's local `shared_with_household_id` marker. A modest cosine `FLOOR` (`apps/web/src/search/semanticSearch.ts`) trims the tail; gte-small's similarities are compressed/high, so ranking carries relevance. When the embedder is unavailable (cold cache, model failed to load, `window.__cybDisableEmbedder` set for tests) the page degrades to the literal `searchRecipes` (which already covers household + "not imported" placeholders).
- **Household sharing:** A user can be in at most one household at a time (≤ 6 members). Sharing is **library-wide and membership-driven**, not per-collection: an active member's whole library (every collection they own + all recipes/ingredients/instructions) is readable by the other active members. The `household_members.library_shared` flag (default `true` — on by default; see `supabase/migrations/20260609000000_household_library_sharing.sql`) gates it; `set_library_sharing(p_household_id, p_enabled, p_attestation)` toggles it, with enabling requiring a one-time rights attestation recorded in `audit_log`. RLS read access is a **claim-vs-column compare** (`20260623000200`): every shared row carries a denormalized `household_id` (the owner's active-*sharing* household, NULL when not sharing — maintained by `refresh_household_denorm` off a `household_members` AFTER trigger; `recipes` also gained an `owner_id` here, alongside the children's from `20260612`), and the viewer's household is read from the JWT `household_id` claim stamped by the `custom_access_token_hook` (`20260623000000`). So the household read branch is `owner_id <> (select auth.uid()) and household_id = (auth.jwt() ->> 'household_id')::uuid` — no `household_members` self-join, no security-definer call (`is_admin` is a claim too). The `own` branch (`owner_id = (select auth.uid())`) is still OR'd **first**, so the household compare is never evaluated for the owner's own row — keeps Supabase Realtime delivery working. `viewer_can_read_owner_library` was dropped. Transitions (create/join/leave/delete household) call `supabase.auth.refreshSession()` in `household/api.ts` so the new claim takes effect immediately (cross-user changes — being removed, admin grant/revoke — take effect on that user's next refresh, ≤ `jwt_expiry`). **Hosted deploy:** the access-token hook must also be enabled in the Supabase dashboard (Authentication → Hooks); `config.toml` only configures local. Co-members' new content has no per-row realtime signal, so `SyncProvider` re-pulls household content on tab focus + a slow interval (`HOUSEHOLD_POLL_MS`); the pull (`pullHouseholdSharedContent` in `sync.ts`) fetches `household_id = <our household> and owner_id <> me` by `updated_at` watermark (indexed) and tags each row locally with `shared_with_household_id` (a local-only marker; the vestigial server column of that name is unrelated). A `household_members` change resets the household watermark (`resetHouseholdWatermarks`) for a full re-pull, so a freshly-shared back-catalog (old `updated_at`) surfaces. Other server-side enforcement: a partial unique index on `household_members(user_id) where left_at is null` enforces one-active-membership; `accept_household_invite` enforces the 6-member cap and 7-day cooldown; the `enforce_household_public_cascade` trigger blocks `is_public = true` on a collection whose owner shares their library unless `last_share_attested_at` is within 5 minutes (the `attest_public_share` RPC bumps it) — and that ToS+attestation gate lives *inside* the library-shared branch so plain publishes aren't gated (per `20260606000600`). Every state change records an `audit_log` row via the `record_audit` helper. Frontend lives under `apps/web/src/household/` (api, queries, `LibrarySharingSection`, audit-log view) plus `pages/HouseholdPage.tsx` and `pages/HouseholdJoinPage.tsx`; the collection page shows a read-only `CollectionShareSection` badge.
- **Terms of Service gate:** Sharing / publishing actions call `require_current_tos()` server-side. If the caller's `profiles.tos_version` is below `current_tos_version()`, the RPC raises with `TOS_NOT_ACCEPTED:` prefix; the frontend catches this in `isTosNotAcceptedError` and opens `AcceptTosGate`. Legal text lives in `apps/web/src/legal/content.ts`; the `LegalPage` component renders it under `/legal/{terms,aup,dmca,privacy}`. Bumping the version requires a follow-up migration so the legal record is checked into the schema.
- **Nutrition analysis:** Per-recipe nutrition uses USDA FoodData Central as the primary source and Open Food Facts as the fallback. Lookups go through the `nutrition` Edge Function (Vault secret `nutrition_worker_config` holds `{ function_url, service_role_key, usda_fdc_key }`), which writes every hit into `nutrition_facts_cache` keyed by `(source, source_id)` so the second view of any recipe is network-free. `ingredient_nutrition_mappings` is the per-user (with platform-default fallback) "this ingredient string → that USDA entry" override table; the `resolve_nutrition_mapping` RPC handles the user-row-then-platform-row lookup. The math lives in `packages/domain/src/services/nutritionMath.ts` (pure functions: `quantityToGrams` for unit conversion, `totalNutrition` to aggregate per-100g facts × grams, `scaleToServing` with proportion-of-yield and by-weight modes). UI sits on the recipe page via `RecipeNutritionPanel` + `IngredientMatchOverrideDialog`. **Matching engine:** messy ingredient names are reduced to clean search terms by `extractIngredientTerms` (`packages/domain/src/services/ingredientTerms.ts`, byte-for-byte ported to `supabase/functions/nutrition/_ingredientTerms.ts` — keep in sync; the domain test table is the contract): strips parentheticals, prep, "or other X" alt-lists, size/counting words, while protecting nutrition-relevant modifiers (whole/skim/full-fat/raw/all-purpose…). The `search_nutrition_foods(p_query, p_limit, p_generic_only)` RPC (`20260608000400`) does **OR retrieval** (not the old strict-AND that returned nothing for "garlic cloves, minced") ranked by: full coverage → USDA head-noun match (descriptions are head-first, e.g. "Salt, table") → calories-present → ts_rank → specificity (fewer extra description tokens) → tier → source_id. Tier is deliberately a *late* tiebreaker — head-noun + specificity beat a "Foundation row that merely contains a query word". Auto-match passes `p_generic_only => true` (Branded excluded — 455k rows that otherwise swamp generics); the override dialog passes `include_branded` so users can still pick a brand. When lexical is weak (no hit, or top hit misses the head noun) the edge function falls back to **semantic search**: `search_nutrition_foods_semantic` (`20260608000500`) does pgvector cosine over gte-small embeddings of the ~13.5k generic foods (`nutrition_food_embeddings`, backfilled by `scripts/embed-nutrition-foods.ts`; query embedded at runtime via `Supabase.ai`). Top ingredient strings (~half of corpus occurrences) are seeded as platform-default mappings (`20260608000600`, curated in `scripts/nutrition-seed-reviewed.tsv` via `scripts/seed-nutrition-mappings.ts`) so staples resolve instantly and exactly.

## Domain model overview

- **Quantity:** Discriminated union — ExactQuantity, FractionalQuantity, RangeQuantity. All immutable.
- **Ingredient:** Discriminated union — MeasuredIngredient (has quantity), VagueIngredient (e.g., "salt to taste").
- **Recipe:** Immutable. Has title, optional servings, ingredients list, instructions list, recipe-specific conversion rules. Transformation methods (scale, convert) return new instances.
- **Instruction:** Has step number, text, and ingredient references (IngredientRef links to Ingredient + Quantity).
- **Unit:** Rich enum with system (metric/imperial/whole/special), dimension (volume/weight/count/taste), and abbreviations.
- **ConversionRegistry:** Layered priority system — HOUSE (user overrides) > RECIPE (recipe-specific) > STANDARD (global defaults). Immutable; `withRule()` returns new instance.
- **RecipeCollection:** Discriminated union — Cookbook (author, ISBN), PersonalCollection (description, notes), WebCollection (source URL).
- **UserLibrary:** Aggregation of all collections.
- **RecipeService:** Facade for import (JSON + plain text), scale, convert, search by ingredient, shopping list generation.
- **ShoppingList:** Aggregates ingredients across multiple recipes. Combines like items. Separates uncountable items (VagueIngredients).

## Conventions

- TypeScript strict mode. No `any`.
- Immutable domain objects — transformation methods return new instances.
- Discriminated unions over class hierarchies. Tag with a `type` field.
- Factory functions (`createRecipe()`, `createCookbook()`) over constructors for complex objects.
- All collections defensively copied — never expose mutable internal arrays.
- Tests with Vitest. Component tests with Testing Library. E2E with Playwright.
- Tailwind CSS + Radix UI for styling and accessible components.

## Backend conventions

- Supabase PostgreSQL with Row Level Security on every table.
- Users see their own data + public collections. Enforced at the database level, not the application level.
- Atomic multi-table operations (e.g., forking a collection) use Postgres RPC functions, not application-level transaction logic.
- Schema changes go in `supabase/migrations/` as numbered SQL files.

## Running locally

The Supabase CLI is installed into `./.bin/supabase` by
`scripts/install-supabase-cli.sh` (the binary is gitignored since it's
platform-specific and ~100MB). Local Supabase ports are shifted to the
54420s (54421 API, 54422 DB, 54423 Studio, 54424 Mailpit, 54427
Analytics, 54429 pooler) to avoid conflicts with other Supabase projects
on the same host.

```bash
# Install deps + Supabase CLI (one-time per clone / per runner)
pnpm install
scripts/install-supabase-cli.sh

# Domain tests (no infra needed)
pnpm --filter @cookyourbooks/domain test

# Typecheck everything
pnpm typecheck

# Web dev server (port 5173)
pnpm --filter @cookyourbooks/web dev

# Start local Supabase (applies migrations + seed.sql)
./.bin/supabase start

# Reset the local DB (re-apply migrations + seed)
./.bin/supabase db reset

# End-to-end tests (Playwright, against local Supabase)
pnpm --filter @cookyourbooks/web test:e2e
```

E2E specs live in `apps/web/e2e/` and drive the real app against the local
Supabase. Each test spins up a fresh admin-created user (see
`e2e/support/admin.ts`) and deletes it in teardown — no shared state. The
suite runs with one worker on purpose: parallel workers contend on the
shared local Supabase realtime channel and cause flakes. Chromium: by
default Playwright uses its own managed browser (`playwright install
chromium`). If you want to reuse a pre-downloaded copy, set
`PLAYWRIGHT_CHROMIUM_PATH`; the config also falls back to a known local
cache path (`~/.cache/ms-playwright/chromium-1217/`) if it exists.

## CI

GitHub Actions workflows live in `.github/workflows/` and run on
self-hosted runners:

- `ci.yml` — every push/PR: typecheck, unit tests, web build, full
  Playwright E2E against a freshly-started local Supabase stack. Needs a
  Linux runner with Docker. On failure uploads the Playwright HTML
  report + raw traces as artifacts.
- `mobile.yml` — Capacitor sync check on every push/PR that touches
  `apps/mobile/**`; on-demand iOS/Android native builds via
  `workflow_dispatch`. iOS needs a macOS runner with Xcode.

Runner labels and bring-up steps are in `.github/RUNNERS.md`.

The web app reads Supabase credentials from `apps/web/.env.local`. On `supabase
start` the CLI prints the publishable key — update `.env.local` if it ever
changes.

## Sentry (self-hosted)

Errors + perf tracing + error-only session replay land in the
self-hosted Sentry at `https://sentry-cyb.work.ripley.cloud` under the
org slug `cyb`, split across projects so each surface has its own
release tracking, symbolication artifacts, and quota. The DSN suffix is
the numeric project id; the human-readable slug is what
`@sentry/vite-plugin` / `sentry-cli` / fastlane upload against:

| Surface | Project slug | DSN suffix | SDK |
| --- | --- | --- | --- |
| Web (Vercel) | `cyb-react` | `…/2` | `@sentry/react` |
| iOS via Capacitor | `cyb-capacitor` | `…/4` | `@sentry/capacitor` (wraps `@sentry/react` + native Cocoa SDK) |
| Edge functions (Deno) | `cyb-deno` | `…/3` | `@sentry/deno` via esm.sh |

Both Deno edge functions (`import-worker`, `nutrition`) report to the
single `cyb-deno` project via one shared `SENTRY_DSN` secret —
edge-function secrets are global to the Supabase project, so there's one
value for every function.

> **Build defaults:** `vite.config.ts` defaults `SENTRY_ORG=cyb` /
> `SENTRY_PROJECT=cyb-react`, so the Vercel build only needs
> `SENTRY_AUTH_TOKEN` set to upload source maps (the plugin runs
> `silent: true`, so a missing token / wrong slug fails quietly). The
> mobile CI build overrides `SENTRY_PROJECT=cyb-capacitor` so the bundle
> shipped in the IPA uploads its JS maps to the project its events go to.

The browser bundle picks its DSN at runtime via Capacitor platform
detection (`apps/web/src/sentry.ts`): on iOS/Android it routes through
`@sentry/capacitor` which initializes both the JS SDK and the native
`@sentry/cocoa` SDK in one call. The native SDK is what captures
crashes, ANRs, native plugin errors, and enriches JS events with
device context (battery, free disk, OS patch level). The browser SDK
is what captures JS/React errors, network breadcrumbs, and replay.

- **DSNs:** baked in as defaults (DSNs are public — they only authorize
  ingest, not read). Override with `VITE_SENTRY_DSN` (web) /
  `VITE_SENTRY_DSN_CAPACITOR` (Capacitor) at build time if you point a
  build at a different project. The edge function reads `SENTRY_DSN`
  from Supabase secrets and falls back to the baked-in `…/3` value if
  unset.
- **Replay:** errors-only (`replaysOnErrorSampleRate: 1.0`,
  `replaysSessionSampleRate: 0`). `maskAllText` + `maskAllInputs` +
  `blockAllMedia` keep recipe contents and photos out of the payload.
- **Performance tracing:** 10% sampling for web/iOS, 100% for the edge
  function (short-lived invocations).
- **User identity:** `setSentryUser` is wired through `AuthProvider`,
  sending the Supabase user UUID only. No email/display name.
- **Dev-only events:** disabled by default. Set
  `VITE_SENTRY_ENABLE_DEV=1` to opt a local build in to ingest.
- **Native pod (iOS):** `@sentry/capacitor` registers as a Capacitor
  plugin (`Podfile` updated by `cap sync`). The Sentry Cocoa pod is
  installed by `pod install` inside the fastlane build step on the
  macOS runner — Linux dev boxes skip the install but the JS side
  still works.
- **Edge function setup:** the DSN is baked in but can be overridden
  by setting the `SENTRY_DSN` secret:

  ```bash
  # Hosted
  ./.bin/supabase secrets set --project-ref <ref> \
    SENTRY_DSN='https://…@sentry-cyb.work.ripley.cloud/3'
  # Local dev
  SENTRY_DSN='…' ./.bin/supabase functions serve import-worker --no-verify-jwt
  ```

- **Source map upload (web):** Vite's `@sentry/vite-plugin` uploads
  source maps when `SENTRY_AUTH_TOKEN` is in the build env. Skipped
  silently otherwise. Other knobs (`SENTRY_URL`, `SENTRY_ORG`,
  `SENTRY_PROJECT`, `VITE_SENTRY_RELEASE`) have sane defaults — see
  `apps/web/vite.config.ts`. On Vercel set `SENTRY_AUTH_TOKEN` as a
  secret and the plugin self-activates on every deploy.
- **dSYM upload (iOS):** wired into the `beta` fastlane lane via
  `fastlane-plugin-sentry` (see
  `apps/mobile/ios/fastlane/Fastfile:upload_dsyms_to_sentry`). The
  upload runs after `gym` and before `pilot`, gated on
  `SENTRY_AUTH_TOKEN` so unconfigured / dev machines no-op cleanly.
  A standalone `upload_dsyms` lane re-uploads from the most recent
  Xcode archive (or a `path:` override) without rebuilding.
- **Power-user debug:** set
  `localStorage.cookyourbooks.sync.consoleMirror = '1'` in the
  browser console to re-enable info-level sync log mirroring (off by
  default to save IPC cost on iPad / under Playwright).

## Setting up the nutrition worker

The `nutrition` Edge Function calls USDA FoodData Central (primary, free
key, https://fdc.nal.usda.gov/api-key-signup.html) and Open Food Facts
(fallback, no key). Setup mirrors the OCR worker — the key lives in
Vault, never in the client bundle.

### Local development

```bash
# 1. Start Supabase, serve the nutrition function alongside import-worker.
./.bin/supabase start
./.bin/supabase functions serve nutrition --no-verify-jwt

# 2. Register the secret. Service-role key from `./.bin/supabase status`.
./.bin/supabase db psql <<'SQL'
select vault.create_secret(
  json_build_object(
    'function_url', 'http://host.docker.internal:54321/functions/v1/nutrition',
    'service_role_key', 'PASTE_FROM_supabase_status',
    'usda_fdc_key', 'YOUR_USDA_FDC_KEY'
  )::text,
  'nutrition_worker_config',
  'Nutrition lookup endpoint + USDA key'
);
SQL
```

The Open Food Facts fallback fires automatically when USDA returns no
hits; no extra config required.

## Setting up the OCR worker

The bulk OCR pipeline (`/import`) relies on a Supabase Edge Function
named `import-worker`. The database wakes it via the `ocr_kick` RPC
(invoked both by `pg_cron` and directly by the UI after upload). If the
worker isn't configured, `ocr_kick` raises a Postgres exception whose
message starts with `OCR_WORKER_NOT_CONFIGURED:` and queued items
sit in `PENDING` forever. The batch board surfaces a banner with a
"Process now" button that re-raises this error verbatim to the user.

### Local development

```bash
# 1. Start Supabase (Postgres + Storage + Studio + Realtime).
./.bin/supabase start

# 2. Serve the Edge Function. Leave this running in a separate terminal.
#    --no-verify-jwt lets pg_net call it without minting a JWT.
./.bin/supabase functions serve import-worker --no-verify-jwt

# 3. Register the function URL + service-role key in Vault.
#    Get the service role key from `./.bin/supabase status` (look for
#    "service_role key"). Connect to the local DB and run:

./.bin/supabase db psql <<'SQL'
select vault.create_secret(
  json_build_object(
    -- pg_net runs inside the Postgres container, so the URL must be
    -- reachable from there. On Docker Desktop use host.docker.internal;
    -- on Linux either enable host-gateway or use the kong-routed URL
    -- http://kong:8000/functions/v1/import-worker
    'function_url', 'http://host.docker.internal:54321/functions/v1/import-worker',
    'service_role_key', 'PASTE_FROM_supabase_status'
  )::text,
  'import_worker_config',
  'OCR worker endpoint + creds'
);
SQL
```

After step 3, `pg_cron` will wake the worker every 30s and `ocr_kick`
will fire immediately when a new batch is uploaded. To rotate the
secret, `select vault.update_secret(<id>, '<new json>')`.

### Production (Supabase hosted)

```bash
# 1. Deploy.
./.bin/supabase functions deploy import-worker --project-ref <ref>

# 2. Set the secret. The function URL in hosted Supabase is
#    https://<ref>.functions.supabase.co/import-worker
#    The service role key lives under Project Settings → API.
#    Set via Studio's Vault UI, or via SQL with the production keys.
```
