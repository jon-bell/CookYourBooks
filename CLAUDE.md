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
- **Recipe children are JSONB (2026-07-08):** Ingredients and instructions are **not** separate tables. They live as two JSONB columns on the recipe row — `recipes.ingredients` and `recipes.instructions` (each instruction embeds its `ingredientRefs`, so the old `instruction_ingredient_refs` join table is gone too). No server-side query ever filtered/searched/aggregated on child content, so nothing was lost; a large amount of machinery was deleted (denormalized `owner_id`/`household_id` on the children + their maintenance triggers, per-child RLS policies, the delete-all-then-reinsert in `save_recipes_graph`, the id-remap in `fork_collection`, and child realtime subscriptions). The wire/JSON contract (camelCase = domain field names) is `packages/db/src/recipeJson.ts` (`serializeChildren`/`deserializeChildren`, plus `legacyChildRowsToStored` used only by the on-device backfill) — the round-trip test is the contract. `rowToRecipe(row)` reads the JSON; `recipeToInsert` writes it. `recipes.has_content` is derived (in `save_recipes_graph` / on local write) from the two arrays. The client mirrors both columns as JSON **text**, plus a local-only lowercased `ingredients_text` column that backs ingredient-name search (replacing the old correlated `EXISTS`). Migration: `supabase/migrations/20260708000000_recipe_children_to_jsonb.sql` (big-bang backfill + `drop table`); the CLI/MCP RPCs (`cli_get_recipe`/`cli_export_library`/`cli_import_recipe`/`cli_search_recipes`) still expose their snake_case external contract but read/write the JSON; existing on-device rows fold in via the `recipe_jsonb_v1` backfill runner (`apps/web/src/local/backfill.ts`, `SCHEMA_VERSION` 8).
- **CRDT at the edges:** cr-sqlite gives column-level LWW merge semantics among SQLite peers. Since Supabase Postgres is not a cr-sqlite peer, merges across the sync boundary are row-level LWW (driven by Postgres `updated_at`). Recipe children (ingredients + instructions) are stored as **JSONB columns on the recipe row** (see "Recipe children are JSONB" below), so a concurrent edit to two different ingredients of the *same* recipe resolves as whole-recipe LWW, not per-ingredient — an intentional simplification (recipes are single-owner; the push path already round-trips through Postgres row-level LWW, so per-field merge never survived the sync boundary anyway).
- **Domain purity:** `packages/domain` has zero framework dependencies — pure TypeScript types, conversion logic, recipe service, parsing, and export. Testable in isolation.
- **Repository pattern:** `RecipeRepository` / `RecipeCollectionRepository` interfaces live in `packages/domain`. The Supabase-talking adapters in `packages/db` are used *only* by the sync engine; UI code never talks to them directly.
- **Auth:** `apps/web/src/auth/AuthProvider.tsx` holds the session. Email/password + Google OAuth. `SyncProvider` boots the local DB and kicks off the first pull when a session appears.
- **No Edge Functions, with one exception:** All backend logic uses Supabase views (`public_collections`), RLS policies, and Postgres RPC functions (`fork_collection`). PostgREST handles queries directly. Forks are pulled into the local cache via `syncNow()` after the RPC returns. The narrow exception is `import-worker`: the bulk OCR pipeline (see `supabase/migrations/20260522000000_imports.sql`) is a long async job that calls a third-party LLM with the user's key — running it from the browser would block, retry poorly, and leak the API key, so it's an Edge Function that reads keys from Vault under the service role. (The LLM-key family — `nutrition`, `video-import`, `pdf-import`, `isbn-scan`, `ocr-key-test` — follow the same Vault-key rationale; `library-snapshot` is the one read-only exception, see "First-load snapshot" below.)
- **IDs:** Domain factories mint UUIDs via `crypto.randomUUID()` so they round-trip through Postgres `uuid` columns unchanged.
- **OCR import:** A multimodal LLM (Gemini or any OpenAI-compatible vision model) converts a photo straight into JSON matching our domain shape. OCR runs **server-side** in the `import-worker` Edge Function (`supabase/functions/import-worker/ocr.ts` `runOcr`, multi-image-per-call) — the browser uploads page images via `apps/web/src/import/uploadBatch.ts`; there is no browser-side `ocr.ts`. The validator in `apps/web/src/import/llm.ts` is tolerant — malformed ingredients fall into `leftover` instead of throwing (this `parseLlmJson` is copied verbatim into each Edge Function's `parser.ts`). The default provider/model/prompt live server-side in `user_ocr_prefs`; keys live in Vault, one row per (owner, provider, **endpoint**) in `user_ocr_keys` — the `openai-compatible` provider supports any number of named endpoints (OpenAI, OpenRouter, Groq…), each with its own key + base URL (`20260712000100`). Batches snapshot `default_endpoint`/`fallback_endpoint` alongside provider/model so the worker knows which key row to decrypt via `ocr_resolve_effective_key`. On a recitation/content-filter refusal (Gemini `RECITATION` or an OpenAI-compat `finish_reason=content_filter`, both classified as errorKind `RECITATION`), the retry surfaces (recitation banner, Re-OCR buttons) offer a picker over the user's saved models (`user_ocr_models`, Settings → Saved models) so a retry can hop model/endpoint/provider. Only the "Fallback model" pref remains in localStorage (`cookyourbooks.ocr.fallback.v1`, `apps/web/src/settings/fallbackPrefs.ts`). Tests override via `window.__cybOcrShim`.
- **Single-source LLM import (link / PDF):** Two streamlined "one recipe" importers sit beside the bulk OCR board. `video-import` (`supabase/functions/video-import/`, client `apps/web/src/import/videoImport.ts`, page `ImportLinkPage` at `/import/link`) extracts from a pasted/shared URL. `pdf-import` (`supabase/functions/pdf-import/`, client `apps/web/src/import/pdfImport.ts`, page `ImportPdfPage` at `/import/pdf`) takes the rendered pages of a shared PDF and OCRs them all in one Gemini call into a single recipe. Both resolve the user's key from Vault, meter into the LLM Cost Center (`misc_llm_usage_record`, features `video`/`pdf`), and save via `createRecipe` + `findOrCreateWebCollectionByPlatform` with `sourceUrl` set. The iOS Share Extension (`apps/mobile/ios/App/Share to CookYourBooks/`) accepts links, PDFs (`com.adobe.pdf`), and images, copying files into the app group; the `CybFile` native plugin (`apps/mobile/ios/App/App/CybFilePlugin.swift`, registered in `ViewController.capacitorDidLoad`) reads the bytes back to the web layer (`apps/web/src/import/sharedFile.ts`). Share routing/parse: `apps/web/src/import/shareIntent.ts` + `shareUrlParse.ts` → `App.tsx` `ShareIntentListener`. PDF source URL is pulled from the print header/footer text layer by `apps/web/src/import/pdfSourceUrl.ts`.
- **Mobile:** `apps/mobile` is a Capacitor shell over `apps/web/dist`. Native surfaces are camera (`@capacitor/camera`) and haptics (`@capacitor/haptics`). Both code paths live in `apps/web` and feature-detect Capacitor at runtime, so no code forks by platform. The iOS native project (`apps/mobile/ios/`) is committed; release flow is fastlane-driven from `apps/mobile/ios/fastlane/` (`fastlane beta` → TestFlight, `fastlane release` → App Store). Bundle ID `app.cookyourbooks`, team `YNDYJ3A9CQ`, signing material in the private `jon-bell/cookyourbooks-certs` repo via `fastlane match`. See `apps/mobile/README.md` for the full workflow.
- **Keyboard shortcuts:** `apps/web/src/keyboard/shortcuts.ts` binds `/`, `n`, `e`, `c`, `f` (send feedback), `?`, and `g l`/`g d`/`g s` chords. The global listener ignores keystrokes originating inside `input`/`textarea`/`contenteditable`.
- **Semantic search:** `/search` scores locally-cached recipe vectors by cosine. Model is **`gte-small` (384d)**, run two ways that produce cosine-comparable vectors: the browser loads `Xenova/gte-small` via `@huggingface/transformers`, and the Edge Function worker uses the runtime-native `Supabase.ai.Session('gte-small')` (transformers.js has no working ONNX backend in the edge runtime). `packages/domain/src/services/embeddingModel.ts` splits `EMBEDDING_MODEL_ID` (the browser HF loader id) from `EMBEDDING_STORED_MODEL` (`'gte-small'`, the value written to / compared in `recipe_embeddings.model`) and holds the shared text-builder + SHA-256. **Everything expensive lives in one Web Worker** (`apps/web/src/search/searchWorker.ts`): it owns both the gte-small pipeline *and* the library's vector matrix, so a query is a string in and at most `limit` recipe ids out — no inference on the UI thread and no per-query vector traffic. `apps/web/src/search/workerClient.ts` is the main-thread half (worker singleton, request correlation, the `EmbedderStatus` pub/sub that `useSearch` renders, and matrix hydration); the protocol union is `searchProtocol.ts`, shared by both sides so they can't drift. The matrix is transferred in once via `listEmbeddingVectors` and re-hydrated wholesale whenever `getEmbeddingVersion()` (bumped by every local `recipe_embeddings` write) moves — a redundant refresh beats a stale vector. Result metadata is read per-query for just the returned ids (`listSearchHitsByIds`), which keeps titles fresh *and* re-applies the visibility filter, so a stale hydration can never leak an un-shared recipe. `dtype: 'q8'` weights (~30 MB) are cached by the library in Cache Storage; ONNX threading is pinned to `numThreads = 1` because enabling it would need COOP/COEP headers neither the Vite build nor the WKWebView shell serves. Vectors live canonically in `public.recipe_embeddings` (pgvector) and mirror to local SQLite as packed `Float32Array` BLOBs (`recipe_embeddings` table, not CRR). On recipe save the browser embeds locally and pushes via `embed_upsert_client` (outbox `embedding_push` kind); database triggers also enqueue `recipe_embedding_jobs` which the import-worker drains with `runEmbedLoop`. **Household-shared recipes are searchable too:** `recipe_embeddings` carries the same denormalized `owner_id`/`household_id` as the other shared tables (`20260624000000`, trigger-stamped from the parent recipe, refreshed by `refresh_household_denorm`) and the same claim-based read policy, so co-members' vectors pull into the local mirror (`household_id = <jwt claim> and owner_id <> me`, in `pullHouseholdSharedContent`) and both `listEmbeddingVectors` and `listSearchHitsByIds` include them via the collection's local `shared_with_household_id` marker. An adaptive cosine cut (`adaptiveFloor` in `apps/web/src/search/semanticSearch.ts`) trims the tail; gte-small's similarities are compressed/high, so ranking carries relevance. When the embedder is unavailable (cold cache, model failed to load, `window.__cybDisableEmbedder` set for tests) the page degrades to the literal `searchRecipes`. **Search state lives in the URL** (`/search?q=…&type=…`, written with `replace` on the 250ms debounce) so a Back — on iOS the native WKWebView edge-swipe, which `useHardwareBack` does *not* cover — remounts the page with its query intact, re-serves the hits from React Query's cache, and gives `useScrollRestoration` something tall enough to restore into. Both search paths cap at `SEARCH_LIMIT`; `searchRecipes` takes an optional `limit` for this and the substring path over-fetches by one row so the page can honestly say "200+". Per-query stage timings are always collected by `apps/web/src/search/perf.ts` (console-mirrored behind the `cookyourbooks.sync.consoleMirror` flag, and attached to feedback reports). **FTS5 was measured and rejected** for the literal scan: cr-sqlite's wasm does ship it, but at 16k recipes it is ~9× slower than `LIKE` on common terms (rowid join per hit + sort) and drops infix matching.
- **Feedback / error reports:** `/feedback` (own reports) + `/admin/feedback` (triage) plus a `FeedbackDialog` opened in place from the account menu, the mobile sheet, or the `f` shortcut — in place, not on its own route, so the breadcrumb trail still points at the page the user was on. `apps/web/src/feedback/` collects the evidence: a 100-entry breadcrumb ring buffer (`breadcrumbs.ts`, fed by one delegated document click listener + the route listener in `BreadcrumbTracker.tsx`, persisted to sessionStorage on `pagehide` so a crash-then-reload keeps the run-up), an error/warn ring buffer (`consoleTail.ts`, wrapping `console.error`/`warn` plus `error`/`unhandledrejection`), the `getSyncLog()` tail, device/build context (`VITE_SENTRY_RELEASE` + `getSentryStatus()`), and the last search timing breakdown. `payload.ts` assembles and trims it under the server's size guard. A submit fans out to **two sinks**: Sentry first (scoped `captureMessage` + JSON attachment + `captureFeedback`, the `SyncDebugDialog.uploadLogs` pattern), then the durable row via the security-definer `feedback_submit` RPC carrying the returned event id. Table `feedback_reports` (`supabase/migrations/20260713000000_feedback_reports.sql`) follows the `sync_transfer_events` shape — denormalized `household_id`, own-branch-first `_read` policy, writes only through the RPC — plus an `is_admin`-claim branch so the developer can read every report, and an admin-only update policy for `status`. A submit that fails on transport is queued in localStorage (`pending.ts`) and retried on launch and on `online`; a server rejection throws so the user sees why.
- **Household sharing:** A user can be in at most one household at a time (≤ 6 members). Sharing is **library-wide and membership-driven**, not per-collection: an active member's whole library (every collection they own + all recipes/ingredients/instructions) is readable by the other active members. The `household_members.library_shared` flag (default `true` — on by default; see `supabase/migrations/20260609000000_household_library_sharing.sql`) gates it; `set_library_sharing(p_household_id, p_enabled, p_attestation)` toggles it, with enabling requiring a one-time rights attestation recorded in `audit_log`. RLS read access is a **claim-vs-column compare** (`20260623000200`): every shared row carries a denormalized `household_id` (the owner's active-*sharing* household, NULL when not sharing — maintained by `refresh_household_denorm` off a `household_members` AFTER trigger; `recipes` also gained an `owner_id` here, alongside the children's from `20260612`), and the viewer's household is read from the JWT `household_id` claim stamped by the `custom_access_token_hook` (`20260623000000`). So the household read branch is `owner_id <> (select auth.uid()) and household_id = (auth.jwt() ->> 'household_id')::uuid` — no `household_members` self-join, no security-definer call (`is_admin` is a claim too). The `own` branch (`owner_id = (select auth.uid())`) is still OR'd **first**, so the household compare is never evaluated for the owner's own row — keeps Supabase Realtime delivery working. `viewer_can_read_owner_library` was dropped. Transitions (create/join/leave/delete household) call `supabase.auth.refreshSession()` in `household/api.ts` so the new claim takes effect immediately (cross-user changes — being removed, admin grant/revoke — take effect on that user's next refresh, ≤ `jwt_expiry`). **Hosted deploy:** the access-token hook must also be enabled in the Supabase dashboard (Authentication → Hooks); `config.toml` only configures local. Co-members' new content has no per-row realtime signal, so `SyncProvider` re-pulls household content on tab focus + a slow interval (`HOUSEHOLD_POLL_MS`); the pull (`pullHouseholdSharedContent` in `sync.ts`) fetches `household_id = <our household> and owner_id <> me` by `updated_at` watermark (indexed) and tags each row locally with `shared_with_household_id` (a local-only marker; the vestigial server column of that name is unrelated). A `household_members` change resets the household watermark (`resetHouseholdWatermarks`) for a full re-pull, so a freshly-shared back-catalog (old `updated_at`) surfaces. Other server-side enforcement: a partial unique index on `household_members(user_id) where left_at is null` enforces one-active-membership; `accept_household_invite` enforces the 6-member cap and 7-day cooldown; the `enforce_household_public_cascade` trigger blocks `is_public = true` on a collection whose owner shares their library unless `last_share_attested_at` is within 5 minutes (the `attest_public_share` RPC bumps it) — and that ToS+attestation gate lives *inside* the library-shared branch so plain publishes aren't gated (per `20260606000600`). Every state change records an `audit_log` row via the `record_audit` helper. Frontend lives under `apps/web/src/household/` (api, queries, `LibrarySharingSection`, audit-log view) plus `pages/HouseholdPage.tsx` and `pages/HouseholdJoinPage.tsx`; the collection page shows a read-only `CollectionShareSection` badge.
- **Terms of Service gate:** Sharing / publishing actions call `require_current_tos()` server-side. If the caller's `profiles.tos_version` is below `current_tos_version()`, the RPC raises with `TOS_NOT_ACCEPTED:` prefix; the frontend catches this in `isTosNotAcceptedError` and opens `AcceptTosGate`. Legal text lives in `apps/web/src/legal/content.ts`; the `LegalPage` component renders it under `/legal/{terms,aup,dmca,privacy}`. Bumping the version requires a follow-up migration so the legal record is checked into the schema.
- **Nutrition analysis:** Per-recipe nutrition uses USDA FoodData Central as the primary source and Open Food Facts as the fallback. Lookups go through the `nutrition` Edge Function (Vault secret `nutrition_worker_config` holds `{ function_url, service_role_key, usda_fdc_key }`), which writes every hit into `nutrition_facts_cache` keyed by `(source, source_id)` so the second view of any recipe is network-free. `ingredient_nutrition_mappings` is the per-user (with platform-default fallback) "this ingredient string → that USDA entry" override table; the `resolve_nutrition_mapping` RPC handles the user-row-then-platform-row lookup. The math lives in `packages/domain/src/services/nutritionMath.ts` (pure functions: `quantityToGrams` for unit conversion, `totalNutrition` to aggregate per-100g facts × grams, `scaleToServing` with proportion-of-yield and by-weight modes). UI sits on the recipe page via `RecipeNutritionPanel` + `IngredientMatchOverrideDialog`. **Matching engine:** messy ingredient names are reduced to clean search terms by `extractIngredientTerms` (`packages/domain/src/services/ingredientTerms.ts`, byte-for-byte ported to `supabase/functions/nutrition/_ingredientTerms.ts` — keep in sync; the domain test table is the contract): strips parentheticals, prep, "or other X" alt-lists, size/counting words, while protecting nutrition-relevant modifiers (whole/skim/full-fat/raw/all-purpose…). The `search_nutrition_foods(p_query, p_limit, p_generic_only)` RPC (`20260608000400`) does **OR retrieval** (not the old strict-AND that returned nothing for "garlic cloves, minced") ranked by: full coverage → USDA head-noun match (descriptions are head-first, e.g. "Salt, table") → calories-present → ts_rank → specificity (fewer extra description tokens) → tier → source_id. Tier is deliberately a *late* tiebreaker — head-noun + specificity beat a "Foundation row that merely contains a query word". Auto-match passes `p_generic_only => true` (Branded excluded — 455k rows that otherwise swamp generics); the override dialog passes `include_branded` so users can still pick a brand. When lexical is weak (no hit, or top hit misses the head noun) the edge function falls back to **semantic search**: `search_nutrition_foods_semantic` (`20260608000500`) does pgvector cosine over gte-small embeddings of the ~13.5k generic foods (`nutrition_food_embeddings`, backfilled by `scripts/embed-nutrition-foods.ts`; query embedded at runtime via `Supabase.ai`). Top ingredient strings (~half of corpus occurrences) are seeded as platform-default mappings (`20260608000600`, curated in `scripts/nutrition-seed-reviewed.tsv` via `scripts/seed-nutrition-mappings.ts`) so staples resolve instantly and exactly.
- **LLM Cost Center:** `/cost` (page `apps/web/src/pages/CostCenterPage.tsx`, data in `apps/web/src/cost/`) shows every LLM query the user — and their household co-members (when library sharing is on) — has run, with per-query cost, token counts, latency, success/failure, which key paid (`key_owner_id` + `key_fingerprint`), and what it produced, plus rollups (by model/provider/member/feature/day). It is an **intentional online-only reporting surface** that bypasses the local-first SQLite cache and reads Supabase directly — same precedent as the household audit log (`listMyAuditLog`) and the `public_collections` view. Source of truth is the existing per-query cost capture in `import_item_attempts` (bulk OCR), `bakeoff_variants` (model bake-offs), and `rewrite_jobs` (instruction rewrites); two one-shot Gemini call sites that previously recorded nothing — `isbn-scan` + `video-import` — now meter into a small `misc_llm_usage` table via the service-role `misc_llm_usage_record` RPC (which computes cost from `model_pricing` when the caller doesn't supply one). The four sources are unioned by the `llm_usage_report` **security_invoker** view (`supabase/migrations/20260625000000_llm_cost_center.sql`) and rolled up by the `llm_usage_summary` **security invoker** RPC — both run under the caller's RLS so they can't leak another household's costs. Household visibility reuses the claim-based pattern: each cost table carries a denormalized `household_id` (maintained by `set_owned_row_household` + `refresh_household_denorm`) and a consolidated `_read` policy whose household branch is the JWT-claim-vs-column compare; `import_item_attempts` also gained a denormalized `key_owner_id` (stamped by `import_complete`/`import_fail` from the batch) so the OCR arm is self-contained under invoker RLS. Visibility follows `library_shared` automatically (`household_id` is NULL when not sharing). Nav lives in `ACCOUNT_NAV`.

- **Interaction signals (training data):** Two append-only, **owner-only** event tables capture the human judgement that every other telemetry surface here misses — the labels a future on-device model would train on. `search_events` holds one `kind='query'` row per executed search (text, `mode`, `result_count`, `embedder_status`/`embedded_count` so cold-cache sessions can be excluded) plus one `kind='open'` row per result clicked (`opened_recipe_id`/`opened_rank`/`opened_score`/`source_filter`), joined on a client-minted `query_id` — the same trick `sync_transfer_events` plays with `cycle_id`. A query with no matching open is a negative example, which is why the two are separate rows. `suggestion_events` is generic over `surface` (`nutrition_match` | `tag`) and records `action` `auto`/`accepted`/`corrected`/`cleared` with the full ranked `candidates` array, so each row is a complete (input, candidate set, chosen) triple. **These tables deliberately have NO denormalized `household_id` and no household read branch** — unlike every other event table, searches and per-ingredient corrections are personal, so they're absent from `refresh_household_denorm` and there is nothing to re-stamp on a sharing transition. Writes go through the batched security-definer RPCs `record_search_events` / `record_suggestion_events`, which stamp `owner_id` from the caller's JWT and no-op on junk payloads. Client capture is `apps/web/src/signals/` — `capture.ts` buffers, coalesces on a 4s timer / 40-event cap / `pagehide`+`visibilitychange`, drains before awaiting (so a racing enqueue can't double-send), never retries a failed flush (retrying would over-represent flaky connections in the training set), and gates the opt-out once at enqueue. Call sites: `search/useSearch.ts` (records inside `queryFn`, so React Query's `staleTime` naturally dedupes re-searches) + `pages/SearchPage.tsx` (the open), `nutrition/useRecipeNutrition.ts` (the `action='auto'` impression, deduped per page-load via `recordOnce` so the positive class isn't drowned by re-renders), `nutrition/IngredientMatchOverrideDialog.tsx` (accept/correct/clear), `cooking/TagEditor.tsx` (autocomplete accept/correct). Opt-out is per-device localStorage (`cookyourbooks.signals.optOut.v1`, `settings/ProductImprovementSection.tsx` on the Data & deletion tab); retention is 180 days via the `prune_interaction_signals` pg_cron job, and a `profiles` BEFORE DELETE trigger takes the rows with the account. Migration: `supabase/migrations/20260714000000_interaction_signals.sql`. The privacy policy carries a matching collection category + retention row, so **adding a new capture surface means updating `apps/web/src/legal/content.ts` too.**

- **First-load snapshot + data-transfer metrics:** The full pull (brand-new device, or any time the recipes keyset cursor is empty) no longer streams the whole library as dozens of `select('*')` JSON pages. Instead `pullFullSnapshot` (`apps/web/src/local/sync.ts`) calls the **`library-snapshot` Edge Function** (`supabase/functions/library-snapshot/`) — the one *read-only* Edge Function exception — which returns the library as **columnar MessagePack** (`{ cols, rows }`: column names once, then value-arrays; gateway-gzipped). It runs every query under the **caller's JWT** (anon key + `Authorization` header), so the own/household claim-vs-column RLS enforces visibility exactly like PostgREST — it owns no secrets. Two staged requests: `meta` (collections + recipe *cards* — the recipe rows with the heavy `ingredients`/`instructions` JSON stripped) then `bodies` (`{ recipeBodies }`: each recipe's `id` + `ingredients` + `instructions` JSON); `scope` is `'own'` or `'household'` (`household_id = claim AND owner_id <> me`, V1 includes co-members' shared content). The codec + envelope contract live in `apps/web/src/local/snapshotCodec.ts` (`encodeColumnar`/`decodeColumnar`, byte-identical copy in the Edge Function — keep in sync, the roundtrip test is the contract). The client folds decoded rows through the **existing** batch path: `upsertRecipeRowsOnly` (writes recipe cards) for `meta`, then `updateRecipeBodies` (attaches the folded JSON + recomputes the local `ingredients_text` search column) for `bodies`; the keyset cursor is computed client-side via `maxCursor`. **Any failure falls back to the legacy keyset pull**, so the snapshot is never worse than before (and E2E without the function served exercises the fallback). Wired into both `pullAll` (own) and `pullHouseholdSharedContent` (household); incremental pulls are unchanged. **Progressive first-load:** the `meta` stage fires a new `'recipe_metadata'` phase and `SyncProvider` flips `hydrated` on `recipe_metadata`/`recipes`, so the grid renders before bodies + tail topics stream in. **Metrics:** `apps/web/src/local/transferMeter.ts` + an instrumented `fetch` in `apps/web/src/supabase.ts` accumulate per-phase bytes/requests for the cycle's measurement window (`beginMeterWindow`/`meterPhase`/`readMeter`, parallel to `db.ts`'s db-stats window). `SyncProvider` attaches `sync.bytes_pulled`/`bytes_pushed`/`requests` to the `sync.cycle` Sentry span and records one compact row per metered phase via the `record_sync_transfer` RPC. The user-facing **`/data-usage`** page (`apps/web/src/datausage/`, `pages/DataUsagePage.tsx`, nav in `ACCOUNT_NAV`) is an online-only reporting surface mirroring the LLM Cost Center: `sync_transfer_events` table with denormalized `household_id` + claim-based `_read` RLS, a security-definer `record_sync_transfer` write RPC (stamps `owner_id`/`household_id` from the caller's auth), and a security-invoker `data_transfer_report` view + `data_transfer_summary` rollup RPC (`supabase/migrations/20260704000000_data_transfer_metrics.sql`). **Images:** covers/cooking photos now use Supabase Pro render transforms for CDN-cached responsive `srcSet` (`apps/web/src/components/coverUrl.ts`, `CoverImage.tsx`, `cooking/photos.tsx`) instead of fixed pre-resized files.

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
- ESLint (typed rules via `typescript-eslint`) + Prettier, one flat config at the repo root: `pnpm lint` / `pnpm lint:fix`, `pnpm format` / `pnpm format:fix`. Warnings are a staged backlog (`no-unnecessary-condition`, `no-floating-promises`, React-Compiler hooks rules) — don't add new ones; errors fail CI. Deno surfaces (`supabase/functions/`, `scripts/`) and generated files are excluded.
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

- `ci.yml` — every push/PR: typecheck, lint, format check, unit tests,
  web build, full Playwright E2E against a freshly-started local Supabase
  stack. Needs a
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
