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
self-hosted Sentry at `https://sentry-cyb.work.ripley.cloud`.

- **Web/iOS bundle:** DSN is baked in (`apps/web/src/sentry.ts`).
  Override with `VITE_SENTRY_DSN` if you point a build at a different
  project. Replay is opt-in only via error (no baseline session
  sampling). `maskAllText`/`blockAllMedia` are on, so recipe contents
  and photos are scrubbed even when replays do fire. The platform tag
  (`web`, `capacitor-ios`, `capacitor-android`) is auto-detected.
- **Edge Function (`import-worker`):** reads `SENTRY_DSN` at boot —
  no-op if unset. Set with:

  ```bash
  # Hosted
  ./.bin/supabase secrets set --project-ref <ref> \
    SENTRY_DSN='https://…@sentry-cyb.work.ripley.cloud/2'
  # Local dev (no secrets store; pass via env when serving the fn)
  SENTRY_DSN='…' ./.bin/supabase functions serve import-worker --no-verify-jwt
  ```

- **Build-time source map upload (web):** Vite's `@sentry/vite-plugin`
  uploads source maps when `SENTRY_AUTH_TOKEN` is in the build env.
  Skipped silently otherwise. Other knobs (`SENTRY_URL`, `SENTRY_ORG`,
  `SENTRY_PROJECT`, `VITE_SENTRY_RELEASE`) have sane defaults — see
  `apps/web/vite.config.ts`. On Vercel set `SENTRY_AUTH_TOKEN` as a
  secret and the plugin self-activates on every deploy.
- **User identity:** `setSentryUser` is wired through `AuthProvider`,
  sending the Supabase user UUID only. No email/display name.
- **Dev-only events:** disabled by default. Set
  `VITE_SENTRY_ENABLE_DEV=1` to opt a local build in to ingest.
- **Power-user debug:** set
  `localStorage.cookyourbooks.sync.consoleMirror = '1'` in the
  browser console to re-enable info-level sync log mirroring (off by
  default to save IPC cost on iPad / under Playwright).

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
