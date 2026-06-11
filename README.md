# CookYourBooks

A cross-platform, offline-first recipe manager. Photograph the cookbooks you own, let an LLM turn the pages into structured recipes, and cook from any device — web, iOS, or Android — with full offline support and household sharing.

- **Web:** React 19 + Vite + Tailwind + Radix UI
- **Mobile:** Capacitor shell over the same web bundle (no forked UI)
- **Backend:** Supabase (Postgres + RLS, Auth, Realtime, Storage, a few Edge Functions)
- **Local store:** cr-sqlite (SQLite in the browser via WASM, persisted to IndexedDB)

## Features

### Your library
- **Collections** model where recipes come from: cookbooks (author, ISBN), personal collections, and web sources.
- **Recipes** are rich structured data — quantities (exact, fractional, ranges), measured vs. "to taste" ingredients, step-by-step instructions with ingredient references.
- **Scaling and unit conversion** with a layered rule system: your house overrides beat recipe-specific rules, which beat standard defaults.
- **Tags, recently viewed, recently made** for finding your way back to things.

### Importing
- **Photo OCR import** (`/import`): upload a batch of cookbook page photos; a multimodal LLM (Gemini or any OpenAI-compatible vision model, your own API key) converts them into structured recipes. Includes page grouping, per-item review, a "speed importer" for rapid triage, and a model **bake-off** mode for comparing providers.
- **Link import** for recipes from the web, plus video import and ISBN cookbook scanning.
- **Plain-text and JSON import** via the domain parser.

### Cooking
- **Cook mode**: a focused step-by-step view for actually making the recipe.
- **Cooking tracker**: log what you made and when.
- **Shopping lists** aggregated across recipes, with like ingredients combined.
- **Nutrition analysis** per recipe, backed by USDA FoodData Central (with Open Food Facts fallback), including per-serving math and user-correctable ingredient matching.

### Search & discovery
- **Semantic search** (`/search`): recipes are embedded with `gte-small` and ranked by cosine similarity — entirely client-side over the local cache, with a literal-text fallback when the model isn't loaded.
- **Discover** public collections shared by other users, and **fork** them into your own library.
- **Anonymous share links** (`/r/<id>`) for individual recipes.

### Sharing & accounts
- **Household sharing**: up to 6 members; turning on library sharing makes your whole library readable by your household, enforced by Postgres RLS (not application code).
- **LLM cost center** (`/cost`): every LLM call you (and your household) make, with per-query cost, tokens, latency, and rollups.
- **CLI tokens** for scripted access, keyboard shortcuts throughout, and an admin/moderation surface for the public catalog.

### Offline-first sync
Reads never touch the network: every page reads from a browser-resident cr-sqlite database. Writes land locally first, queue into an outbox, and push to Supabase in the background. Pulls are watermark-based and triggered by login, realtime events, and tab focus. Conflicts resolve last-writer-wins. You can capture and edit recipes with no connection at all.

## Repository layout

```
cookyourbooks/
├── packages/
│   ├── domain/         # Pure TypeScript domain model — no framework deps, fully unit-tested
│   └── db/             # Supabase repository adapters + generated types (used only by the sync engine)
├── apps/
│   ├── web/            # Vite web app: UI, local cr-sqlite store, sync engine, OCR import
│   └── mobile/         # Capacitor shell (iOS project committed; fastlane release flow)
├── supabase/
│   ├── migrations/     # Schema, RLS policies, RPC functions
│   └── functions/      # Edge Functions: import-worker (OCR), nutrition, isbn-scan, video-import
├── scripts/            # Tooling (Supabase CLI install, embedding backfills, seeds)
├── PLAN.md             # Product plan & architecture
├── SPEC.md             # As-built spec
└── CLAUDE.md           # Working notes for AI-assisted development
```

Key architectural choices:

- **Domain purity:** `packages/domain` is framework-free TypeScript — immutable objects, discriminated unions, factory functions. Testable in complete isolation.
- **Repository pattern:** UI code only ever talks to local repositories; the Supabase adapters are used exclusively by the sync engine.
- **Database-enforced security:** Row Level Security on every table. Multi-table operations (e.g. forking a collection) are atomic Postgres RPCs.
- **Almost no server code:** backend logic lives in views, RLS policies, and RPC functions. Edge Functions exist only where a long-running job or a secret (LLM/USDA API keys in Vault) demands one.

## Getting started

Prerequisites: Node ≥ 20, [pnpm](https://pnpm.io), Docker (for local Supabase).

```bash
# Install deps + the Supabase CLI (vendored into ./.bin)
pnpm install
scripts/install-supabase-cli.sh

# Start local Supabase (applies migrations + seed)
./.bin/supabase start

# Run the web app on http://localhost:5173
pnpm --filter @cookyourbooks/web dev
```

The web app reads Supabase credentials from `apps/web/.env.local`. `supabase start` prints the publishable key — copy it there if it changes. Local Supabase ports are shifted to the 54420s (54421 API, 54422 DB, 54423 Studio) to avoid clashing with other projects.

Optional workers (only needed for the features that use them):

- **OCR import** — serve the `import-worker` Edge Function and register its URL + service-role key in Vault. See [CLAUDE.md → Setting up the OCR worker](CLAUDE.md#setting-up-the-ocr-worker).
- **Nutrition** — serve the `nutrition` function with a free [USDA FDC key](https://fdc.nal.usda.gov/api-key-signup.html). See [CLAUDE.md → Setting up the nutrition worker](CLAUDE.md#setting-up-the-nutrition-worker).

## Testing

```bash
# Domain unit tests (no infra needed)
pnpm --filter @cookyourbooks/domain test

# Typecheck the whole workspace
pnpm typecheck

# End-to-end tests (Playwright, against local Supabase)
pnpm --filter @cookyourbooks/web test:e2e
```

E2E specs live in `apps/web/e2e/` and run serially on purpose — parallel workers contend on the shared local Supabase realtime channel.

## CI & releases

GitHub Actions (`.github/workflows/`) run typecheck, unit tests, the web build, and the full Playwright suite against a fresh local Supabase stack on every push/PR. Mobile builds are fastlane-driven (`fastlane beta` → TestFlight, `fastlane release` → App Store); a TestFlight build fires automatically on merge to `main`. Errors and performance traces report to a self-hosted Sentry.

## License

[AGPL-3.0](LICENSE)
