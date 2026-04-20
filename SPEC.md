# CookYourBooks — Implemented Spec

A cross-platform, offline-first recipe manager with a shared "table of
contents" for discovering public collections. This document reflects what
is actually built, commits and all, and calls out gaps between PLAN.md's
intention and the current state.

---

## 1. Architecture (as built)

| Layer | Technology | Notes |
|---|---|---|
| UI | React 19 + Vite + Tailwind | Mobile wrapped by Capacitor; no separate mobile codebase. |
| Shared domain | `packages/domain` (zero framework deps) | 47 unit tests. |
| Supabase adapters | `packages/db` | Generated `Database` types; `SupabaseRecipe{,Collection}Repository` + `fork` + `listPublicCollections`. Used by the sync engine, not by UI code directly. |
| Local store | cr-sqlite (`@vlcn.io/crsqlite-wasm`) inside the browser, persisted to IndexedDB | CRR on the four replicated tables; `sync_state` and `outbox` local-only. |
| Sync engine | `apps/web/src/local/sync.ts` | Push → Pull → Realtime subscribe, with an `updated_at` guard that refuses to regress a fresher local row. |
| State | `@tanstack/react-query` | Reads/writes go through the local repositories; mutations call `syncNow()` on success. |
| Auth | Supabase Auth | Email/password + Google OAuth configured (real OAuth requires setting provider creds). |
| Mobile | Capacitor 6 + plugins: Camera, Haptics, Share | `apps/mobile/` is a thin shell over `apps/web/dist`; no forked UI. |
| Tests | Vitest (unit) + Playwright (E2E) | 55 unit + 43 E2E, serialised (`workers: 1`) against local Supabase. |

### Repo layout

```
cookyourbooks/
├── packages/
│   ├── domain/    pure TS: quantities, units, recipes, conversion registry, parsers, markdown export
│   └── db/        Supabase mapping + repositories + RPC helpers
├── apps/
│   ├── web/       Vite + React app (all UI, LLM OCR, cr-sqlite, sync engine, moderation)
│   └── mobile/    Capacitor config + asset sources; native projects checked in by each dev
├── supabase/
│   ├── migrations/
│   └── seed.sql
```

### Repository pattern

`RecipeRepository` / `RecipeCollectionRepository` interfaces in `packages/domain`;
implemented twice:

- `packages/db/src/repositories.ts` — talks to Supabase PostgREST. Used
  **only by the sync engine** (push to server).
- `apps/web/src/local/repositories.ts` — talks to cr-sqlite. Used by
  **every UI hook**. Soft-deletes use a `deleted` flag; the sync engine
  turns those into `DELETE` calls when pushing.

---

## 2. Domain model (`packages/domain`)

- **Quantity**: discriminated union `EXACT | FRACTIONAL | RANGE`. Immutable; factories validate.
- **Unit**: rich catalog with `system` (`METRIC`/`IMPERIAL`/`WHOLE`/`SPECIAL`) and `dimension` (`VOLUME`/`WEIGHT`/`COUNT`/`TASTE`). Includes abbreviations.
- **Ingredient**: discriminated union `MEASURED | VAGUE`.
- **IngredientRef**: link from an instruction step to an ingredient + optional quantity.
- **Instruction**: step number + text + refs.
- **Recipe**: immutable; `scaleRecipe` returns a new instance.
- **Recipe collections**: discriminated union `Cookbook | PersonalCollection | WebCollection`, each with its own metadata fields. Unified as `RecipeCollection`.
- **ConversionRegistry**: layered priority `HOUSE > RECIPE > STANDARD`. Ingredient-specific beats generic at the same level. One-hop transitive search. Immutable; `withRule()` returns a new instance.
- **StandardConversions**: 16 cross-unit conversions (volume + weight, metric + imperial).
- **Services**:
  - `searchRecipes` / `searchLibrary` — title + ingredient substring match.
  - `buildShoppingList` — aggregates across recipes, separates vague items.
  - `parseIngredientLine` — single-line parser. Handles `"2 cups flour"`, `"1 1/2 tsp salt"`, `"salt to taste"`, strips list bullets, handles plural units.
  - `parseRecipeText` — multi-line parser for pasted text. Section headers (Ingredients / Directions / Method / …), step-number strip, heuristic fallback.
- **Markdown export**: `recipeToMarkdown(recipe)` emits a human-friendly snapshot.

### IDs

All domain factories emit `crypto.randomUUID()` so they round-trip
through Postgres `uuid` columns unchanged.

---

## 3. Web app (`apps/web`)

### Pages

| Route | Page | Auth |
|---|---|---|
| `/` | `LandingPage` (unauth) or `LibraryPage` (auth) | — |
| `/sign-in`, `/sign-up` | Auth forms | anon |
| `/discover` | Public collections browser + fork button + report button | anon (discover), auth (fork/report) |
| `/collections/new` | New collection form | auth |
| `/collections/:id` | Collection detail, cover image editor, public toggle, "Add recipe", "Import from photo", delete | auth |
| `/collections/:id/recipes/new` | Recipe editor (seed from `location.state.draft` when arriving from OCR) | auth |
| `/collections/:id/recipes/:rid` | Recipe detail with scaling, unit conversion, share (markdown), cook mode link, edit, delete | auth |
| `/collections/:id/recipes/:rid/edit` | Recipe editor (edit mode) | auth |
| `/collections/:id/recipes/:rid/cook` | Cook mode (full-width buttons, keyboard nav, haptics, screen-wake) | auth |
| `/search` | Title + ingredient search across library | auth |
| `/shopping` | Multi-recipe aggregated shopping list; check marks persist to localStorage | auth |
| `/settings` | LLM OCR provider / key / model / prompt | auth |
| `/admin` | Moderation console: open reports, resolved reports, moderation log | auth + admin |

### Keyboard shortcuts

`/`, `n`, `e`, `c`, `?`, and Gmail-style chords `g l` / `g d` / `g s`.
Defined in `apps/web/src/keyboard/shortcuts.ts`. The `?` key toggles a
help overlay listing every binding.

### Accessibility

- Skip-to-content link.
- `<nav aria-label="Primary">`, `<main>` landmarks.
- Sync badge has `aria-live="polite"` with a descriptive label.
- Focus rings on interactive elements.
- Cook-mode buttons are 44 px+ tall and sticky at the bottom on mobile.

---

## 4. Local-first sync

### Local store

`apps/web/src/local/` — cr-sqlite-wasm opens `cookyourbooks.db` from
IndexedDB, applies a schema migration, and promotes four tables to CRRs
(`recipe_collections`, `recipes`, `ingredients`, `instructions`).
`outbox` and `sync_state` are local-only bookkeeping tables.

### `upsertCollectionRow` / `upsertRecipeRow`

Both refuse to overwrite a row whose local `updated_at` is newer than
the incoming value. This makes pull idempotent even if an older cycle
is still in flight when a user has already typed a new edit.

### Sync cycle (`sync.ts`)

```
cycle(ownerId):
  push_outbox()   -- drain FIFO, break on first failure
  pull_all()      -- fetch updated rows since watermark, per topic
  bump_watermarks
```

A Supabase Realtime channel subscribes to `postgres_changes` on all
four CRR tables; every event triggers `cycle()`. React Query is
invalidated at the end of every cycle.

### Outbox

`enqueue → listPending → markDone/markFailed`. Each user mutation
enqueues one row keyed by `kind` (`collection_save`, `collection_delete`,
`recipe_save`, `recipe_delete`). The push half of the cycle drains it.

### Offline behavior

- Reads always hit local; the app works entirely offline after first sync.
- Writes hit local + enqueue immediately; push retries on the next cycle.
- Reconnect: `online` / `offline` window events or a manual badge click kicks `cycle()`.

---

## 5. OCR import (LLM-backed)

`apps/web/src/import/`:

- `camera.ts` — `@capacitor/camera` on native, `<input type="file" capture>` on web.
- `ocr.ts` — Thin pipeline: capture → `ocrImageToRecipe` → seed the editor's `location.state.draft`.
- `llm.ts` — Two providers:
  - **Gemini** (`generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`) with an `inline_data` image part.
  - **OpenAI-compatible** (`/chat/completions` with `image_url`). Works with OpenAI, Groq, OpenRouter, any self-hosted proxy.
- `parseLlmJson` — Tolerant validator. Accepts optional markdown fences. Drops malformed ingredients into `draft.leftover` rather than throwing.
- Settings UI stores provider / key / model / baseUrl / prompt in `localStorage` under `cookyourbooks.ocr.v1`. The API key **never** syncs through Supabase.
- Tests stub via `window.__cybOcrShim`.

The prompt is user-tunable; `DEFAULT_PROMPT` in
`ocrSettings.ts` is a working placeholder until the canonical one is
supplied.

---

## 6. Shared ToC + Discovery

### How contributions work today

A user creates a collection, then toggles the "Make public" button on
its detail page. The collection's `is_public` flag flips to `true` and
it immediately joins the `public_collections` view. Anyone authenticated
can see it on `/discover`, and anyone can call `fork_collection(id)` to
copy it (collection + recipes + ingredients + instructions) into their
own library.

The `public_collections` view is `security invoker` and excludes banned
owners (see below).

---

## 7. Moderation

### Schema (migration `20260419000400_moderation.sql`)

- `admins(user_id, granted_at, granted_by, note)` — membership table. `is_admin(uid)` helper (security definer, stable).
- `profiles.disabled` + `profiles.disabled_reason` — soft ban flag. A banned user can still sign in and export their data; they cannot publish, and they don't show up on Discover.
- `reports(id, reporter_id, target_type, target_id, reason, message, status, resolved_at, resolved_by)` — with check constraints on `target_type` (`COLLECTION | RECIPE | USER`), `reason` (`SPAM | OFF_TOPIC | OFFENSIVE | COPYRIGHT | OTHER`), and `status` (`OPEN | ACTIONED | DISMISSED`).
- `moderation_actions(id, admin_id, action, target_type, target_id, reason, created_at)` — append-only audit log. Check constraint on `action`: `UNPUBLISH | REPUBLISH | BAN_USER | UNBAN_USER | DISMISS_REPORT | GRANT_ADMIN | REVOKE_ADMIN`.

### RLS posture

- `admins` — readable by self; readable + writable by other admins.
- `reports` — insert by reporter themselves; read by reporter or admin; update by admin only.
- `moderation_actions` — append-only; readable by admins.
- `recipe_collections` gains a `collections_admin_all` policy so admins can directly edit any collection (used by the takedown RPC).
- `profiles_admin_update` allows admins to flip disabled on other users.

### Publishing guard

A `BEFORE INSERT OR UPDATE OF is_public` trigger on `recipe_collections`
raises an exception if a disabled owner tries to flip `is_public = true`.
That means a ban is enforced at the DB layer even if the UI is bypassed.

### RPCs (`security definer`, authenticated)

| RPC | Behavior |
|---|---|
| `moderation_unpublish_collection(target_collection_id, reason)` | Sets `is_public = false`, logs `UNPUBLISH`, auto-`ACTIONED`s any open reports on the target. |
| `moderation_republish_collection(target_collection_id, reason)` | Inverse; logs `REPUBLISH`. |
| `moderation_ban_user(target_user_id, reason)` | Sets `profiles.disabled = true`, unpublishes all their public collections, `ACTIONED`s reports against them or their collections, logs `BAN_USER`. |
| `moderation_unban_user(target_user_id, reason)` | Clears the flag; logs `UNBAN_USER`. |
| `moderation_dismiss_report(target_report_id, note)` | Sets status to `DISMISSED`; logs `DISMISS_REPORT`. |
| `moderation_grant_admin(target_user_id, note)` | Upserts into `admins`; logs `GRANT_ADMIN`. |
| `moderation_revoke_admin(target_user_id, reason)` | Deletes from `admins`; logs `REVOKE_ADMIN`. |

Every RPC checks `is_admin(auth.uid())` first and raises a permission
error if the caller isn't an admin.

### UI

- **User report flow** — On `/discover`, every collection card has a "Report" button (authenticated users only). Opens a modal with a reason dropdown + free-text details. Writes to `reports` via PostgREST.
- **Admin console** (`/admin`) — Three tabs:
  - *Open reports*: the queue. Each card shows reason, age, message, target summary, and action buttons: "Take down", "Ban user", "Dismiss".
  - *Resolved reports*: historical ACTIONED + DISMISSED.
  - *Moderation log*: full `moderation_actions` feed with one-click "Unban" / "Restore" on past actions.
- **Admin link** in the header `UserMenu` only renders when `useIsAdmin()` returns true (queries the `admins` table with RLS-scoped read).

### Test coverage (`e2e/moderation.spec.ts`)

1. A regular user reports a public collection; the `reports` row exists remotely with the right fields.
2. Admin sees the report, takes down the collection. The collection is `is_public = false` remotely, a `moderation_actions` row is logged with the admin's reason, and Discover no longer lists it.
3. Non-admins visiting `/admin` see a polite "restricted to administrators" message (no data leak).
4. A banned user cannot flip `is_public = true` — the trigger refuses at the DB layer. Verified by both a direct REST call and by checking remote state.

### Bootstrap

The first admin is created by direct DB insert. In local dev,
`supabase/seed.sql` promotes the demo user (id
`11111111-1111-1111-1111-111111111111`) to admin. Subsequent admins are
added via `moderation_grant_admin` (callable by any existing admin).

---

## 8. Storage

- **Covers bucket** (`covers`, public). Upload path scoped to `{user_id}/…`; anyone can read, only the owning user can write. Policies live in `20260419000200_covers_bucket.sql`.
- Cover image upload component on the collection page; `CoverImage` reads via `supabase.storage.getPublicUrl`.

---

## 9. Mobile (`apps/mobile`)

- Capacitor config with app id `net.jonbell.cookyourbooks`, `webDir: ../web/dist`.
- Native projects (`ios/`, `android/`) are **not** checked in; each developer runs `pnpm add:ios` / `pnpm add:android` locally. Documented in `apps/mobile/README.md`.
- Assets: `icon-only.png`, `splash.png`, `splash-dark.png` (placeholder artwork). `pnpm --filter @cookyourbooks/mobile assets` regenerates per-platform sizes via `@capacitor/assets` + `sharp`.
- Native integrations live in `apps/web/` and feature-detect `Capacitor.isNativePlatform()`. No forked UI.
- PWA manifest + `apple-mobile-web-app-*` meta tags so Add-to-Home-Screen on mobile browsers also works.

### Native surfaces

- `@capacitor/camera` — OCR capture.
- `@capacitor/haptics` — cook-mode step taps.
- `@capacitor/share` — native share sheet when exporting a recipe (web falls back to Web Share API, desktop falls back to Markdown download).

---

## 9b. CLI (`apps/cli`)

Command-line client, installed via the local workspace or future npm
publish as `cyb`. Mints **no** credentials itself — users generate a
token in Settings → CLI tokens in the web or mobile app, paste it into
`cyb login`.

### Token model

- Format: `cyb_cli_` + 48 hex chars. Prefix makes leaks spot-checkable in
  GitHub secret scanning, server logs, etc.
- Table: `public.cli_tokens(id, owner_id, name, token_hash, prefix,
  created_at, last_used_at)`. Only the SHA-256 hash is stored; the raw
  string is shown exactly once at issue time and never recoverable.
- RLS: owners can `select` / `delete` their own rows. `insert` goes
  through `cli_issue_token` (`security definer`) so the client never
  writes the hash itself.
- Revoke = `delete from cli_tokens where id = ?` (RLS-gated). Any CLI
  still using the token will start seeing `Invalid CLI token`.

### RPC surface

All callable with just the anon key + a token in the body.

| RPC | Returns | Notes |
|---|---|---|
| `cli_issue_token(token_name)` | `text` (raw token) | Requires a signed-in user. |
| `cli_verify_token(raw_token)` | `uuid` owner id (internal) | Hashes the input, bumps `last_used_at`, returns owner or NULL. Not granted to clients. |
| `cli_export_library(raw_token)` | `jsonb` | Full dump of the caller's library. |
| `cli_import_recipe(raw_token, target_collection_id, recipe)` | `uuid` new recipe id | `target_collection_id = null` creates a "CLI imports" collection on demand. |

Admin / public-collection / moderation surfaces are **not** reachable
via CLI tokens. A CLI token grants exactly what the token's owner could
do to their own data.

### CLI commands

```bash
cyb login --url <supabase-url> --anon-key <key> --token <cyb_cli_…>
cyb whoami
cyb export [-o file.json] [--pretty]
cyb import <file.json> [--collection <uuid>]
```

Config at `$XDG_CONFIG_HOME/cookyourbooks/config.json` (mode `0600`),
contains `{ url, anonKey, token }`. The anon key is public by design;
the token is the real secret.

`cyb import` accepts three shapes: a full `cli_export_library` blob, a
`{ recipes: [...] }` single-collection wrapper, or a bare recipe — so
round-tripping an export back into import works without post-processing.

---

## 10. Testing matrix

- **Unit (Vitest)** — 65 tests:
  - `packages/domain` (53): Quantity, Unit, Conversion, Recipe, ShoppingList, Search, parseIngredientLine, parseRecipeText, Markdown, Servings formatting.
  - `packages/db` (3): row ↔ domain mapping round-trip, malformed-row fallback.
  - `apps/web` (5): `parseLlmJson` contract.
  - `apps/cli` (4): login validates token prefix, whoami without config, import without login, compiled binary shebang.
- **E2E (Playwright, chromium)** — 45 tests across 13 spec files: auth (5), collections (5), recipes (4), recipe-features (6), shopping-list (2), search (3), discover (3), covers (2), sync-offline (2), sync-realtime (1), ocr-import (5), moderation (4), cli-tokens (2).

Suite runs serially (`workers: 1`) because parallel runs contended on
the single local Supabase realtime channel. Each test mints a fresh
test user via the Supabase admin API and cleans up in `finally`.

---

## 11. Gaps between PLAN.md intention and the current build

### Planned but not yet built

- **Cross-device CRDT semantics.** *Deliberately skipped* per product
  decision. Row-level LWW on Postgres is enough for single-editor
  recipes; switching to cr-sqlite column-level LWW would need a cr-sqlite
  peer server (not Supabase) and would move the system of record off
  plain Postgres tables, breaking dashboard introspection, the
  `fork_collection` RPC, and the existing moderation queries. See §4 of
  the "CR-SQLite can run over Edge Functions — yes/no" discussion in the
  session log; the tradeoffs are recorded in memory.
- **No `packages/ui`.** Intentionally not split. The web app is the only
  React host (mobile is a Capacitor shell over the same build). Splitting
  now would be churn without benefit; revisit only if a second React
  host (e.g. a web embed widget) is ever added.
- **Deploy.** PLAN.md Phase 2 listed "Deploy web app (Vite → Vercel or
  Supabase hosting)". The web app is runnable locally but nothing is
  deployed. The Supabase project only exists locally.
- **App Store / Play Store listings.** Scaffolding, asset pipeline, and
  PWA manifest are in place, but no store-submission metadata
  (privacy policy, app description, keywords, review screenshots).
- **Landing marketing page** is in the product but it isn't *served*
  publicly — nothing is deployed.

### Deliberate changes vs PLAN.md

- **OCR pipeline pivoted to LLM.** PLAN.md implied Tesseract-style OCR
  + rule-based parsing. We removed Tesseract and implemented LLM-based
  extraction (Gemini + OpenAI-compat vision), which returns structured
  JSON directly. The user-tuned prompt is forthcoming; `DEFAULT_PROMPT`
  is a reasonable placeholder.
- **Realtime + Supabase-driven sync instead of pure CRDT peer sync.**
  PLAN.md left the door open; we chose Realtime (postgres_changes) over a
  cr-sqlite sync server because it plugs into the Supabase primitives we
  already use for auth, RLS, and PostgREST.
- **No Edge Functions at all.** PLAN.md originally contemplated an Edge
  Function for the fork endpoint, then pivoted to PostgREST + RPC —
  which is what's built.
- **Admin moderation.** Not listed in PLAN.md; added here as a full
  stack (schema + RPCs + UI + tests).

### Features PLAN.md mentioned that exist in partial form

- **"Search across all collections"** — implemented as client-side
  search against the local cache (`searchLibrary`), now with a source-
  type filter on `/search`. There's no server-side full-text search
  surface (e.g., `ts_vector`) — unnecessary until libraries get huge.
- **"Screen-awake lock" in cook mode** — implemented via
  `navigator.wakeLock`. Falls back silently on platforms without it;
  native Capacitor doesn't yet set an `idleTimerDisabled`-style override
  (possible follow-up).
- **"Email confirmation"** — Supabase's default flow works; we
  haven't customized the mailer templates or added a dedicated confirmation
  landing.
- **"Keyboard shortcuts, accessibility audit, responsive design"
  (Phase 4 checkbox)** — shortcuts, a11y fixes (skip link, landmarks,
  aria-live, focus rings), and responsive tweaks are in place. A formal
  WCAG conformance audit (axe with a real reviewer) hasn't been run — a
  hosting-adjacent step that pairs well with deployment prep.

### Resolved in the "finish the plan" pass

- **Drag-and-drop recipe ordering.** Implemented via `@dnd-kit` on the
  collection page. A new `recipe_reorder` outbox kind pushes just the
  `sort_order` column, avoiding child-row churn on the server.
- **Step-level ingredient refs.** The editor lets each step chip-select
  referenced ingredients. Cook mode displays them above the step text in
  an amber callout. Full round-trip through local cr-sqlite
  (`instruction_ingredient_refs` table + CRR) and Supabase pull/push.
- **Servings pluralization.** `formatServings` handles regular pluralization,
  `-y → -ies`, and an irregular table (loaf/loaves, person/people, …).
  Used by RecipePage and the Markdown exporter. `servings(1, 'cookies')`
  now renders as "1 cookie".
- **Takedown distinguishability.** Collections gained `moderation_state`
  + `moderation_reason` columns. Admin RPCs flip state on takedown /
  republish. The owner sees an amber banner with the reason on a
  taken-down collection; the "Make public" button is disabled and the
  DB trigger refuses any owner-side attempt to re-publish.
- **Admin reason modal.** `ReasonDialog` replaces every `window.prompt`
  in the admin console. Typed reason, Escape-to-cancel, Enter-to-submit,
  destructive styling where appropriate. The E2E suite drives the dialog.
- **Report rate limiting.** `enforce_report_rate_limit` trigger caps any
  reporter at 20 reports in any rolling 24 hours. Excess attempts raise
  a friendly error surfaced inline by `ReportDialog`.

### Known issues worth tracking

- The `SyncProvider` coalesces overlapping cycles via an `inFlight` ref.
  If a user triggers multiple writes faster than a cycle completes, the
  later ones are queued as outbox entries and processed in the next cycle,
  but a fresh user-initiated `syncNow()` will join an in-flight cycle
  rather than starting a new one. Workaround for tests: wait for the
  badge to leave "Syncing…" before kicking retries.
- Deploy, store-listing metadata, and a formal a11y audit are the
  remaining product-adjacent items. They pair with hosting selection
  and aren't useful to fake in code.
