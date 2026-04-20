# CookYourBooks — Product Launch Plan

## Vision

A cross-platform recipe management app. React web app + native mobile via Capacitor (iOS, Android). Supabase backend with offline-first local data and sync. Shared "table of contents" service for discovering public recipe collections.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   Clients                        │
│  React Web App (Vite)                           │
│  Capacitor Mobile (iOS / Android)               │
└──────────────────┬──────────────────────────────┘
                   │
         ┌─────────┴─────────┐
         │  Shared React UI   │  (one codebase)
         │  + Local Storage   │  (offline-first via PowerSync / cr-sqlite)
         └─────────┬─────────┘
                   │ sync
         ┌─────────┴─────────┐
         │    Supabase        │
         │  - Auth (social + email)
         │  - PostgreSQL (canonical data)
         │  - Realtime (sync triggers)
         │  - Storage (recipe images)
         │  - Edge Functions (table of contents API)
         └────────────────────┘
```

---

## Domain Model

The domain model uses immutable value objects, clean type hierarchies, a layered architecture with repository pattern, and a priority-based unit conversion system.

### Type Design

| Concept | TypeScript approach |
|---------|-------------------|
| Quantities (exact, fractional, range) | Discriminated union `Quantity = ExactQuantity \| FractionalQuantity \| RangeQuantity`, tagged with `type` field |
| Ingredients (measured, vague) | Discriminated union `Ingredient = MeasuredIngredient \| VagueIngredient`, tagged with `type` field |
| Units with metadata | `const Unit` object + `Unit` type, preserving `system`, `dimension`, and abbreviations |
| Unit classification | String literal unions: `UnitSystem = 'METRIC' \| 'IMPERIAL' \| 'WHOLE' \| 'SPECIAL'`, `UnitDimension = 'VOLUME' \| 'WEIGHT' \| 'COUNT' \| 'TASTE'` |
| Collection types | String literal union `SourceType = 'PUBLISHED_BOOK' \| 'PERSONAL' \| 'WEBSITE'` |
| Conversion rules | `interface ConversionRule` with readonly fields |
| Ingredient references | `interface IngredientRef` with readonly fields |
| Recipe collections | Discriminated union `RecipeCollection = Cookbook \| PersonalCollection \| WebCollection` |
| Complex object construction | Factory functions (`createCookbook()`, `createRecipe()`) — no builder pattern needed |
| Nullability | TypeScript strict mode + optional fields (`field?: Type`) |
| Error handling | Result types or thrown errors with type guards |
| Persistence | Repository interfaces (`RecipeRepository`, `RecipeCollectionRepository`) with local SQLite + Supabase adapters |

### Complete Entity List (all preserved)

**Domain Core:**
- `Quantity` (ExactQuantity, FractionalQuantity, RangeQuantity)
- `Unit`, `UnitSystem`, `UnitDimension`
- `Ingredient` (MeasuredIngredient, VagueIngredient)
- `IngredientRef`
- `Instruction`
- `Recipe`
- `ConversionRule`, `ConversionRulePriority`
- `ConversionRegistry` (LayeredConversionRegistry)
- `StandardConversions`

**Collections:**
- `RecipeCollection` (Cookbook, PersonalCollection, WebCollection)
- `SourceType`
- `UserLibrary`

**Services:**
- `Servings`
- `ShoppingList`, `ShoppingItem`
- `RecipeService` — import, scale, convert, search, shopping list generation

**Persistence:**
- `RecipeRepository` (local SQLite adapter + Supabase adapter)
- `RecipeCollectionRepository` (local SQLite adapter + Supabase adapter)
- `MarkdownExporter`

**CLI features → UI features:**
- `show` → Recipe detail view
- `search` → Search bar with ingredient search
- `scale` → Scaling slider/input with side-by-side comparison
- `convert` → Unit conversion picker
- `shopping-list` → Shopping list view with checkboxes
- `cook` → Cook mode (step-by-step with swipe/tap navigation)
- `import json` → File drop / paste import
- `export` → Share as Markdown, PDF, or link
- `collections` → Collection browser with covers
- `collection create` → New collection dialog
- `conversions` → House conversions settings page

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **UI framework** | React 19 + TypeScript | Shared across web + Electron + Capacitor |
| **Build** | Vite | Fast dev, good Electron/Capacitor support |
| **Styling** | Tailwind CSS + Radix UI | Accessible components, rapid iteration |
| **State** | Zustand + React Query | Zustand for local UI state, React Query for server cache |
| **Local DB** | cr-sqlite (CRDT SQLite) or PowerSync | Offline-first with conflict-free sync |
| **Mobile** | Capacitor | iOS, Android wrapping same React app |
| **Backend** | Supabase | Auth, PostgreSQL, Realtime, Storage, Edge Functions |
| **Auth** | Supabase Auth | Email/password, Google, Apple, GitHub OAuth |
| **Image storage** | Supabase Storage | Recipe photos, collection covers |
| **Table of Contents** | Supabase Edge Function + public schema | Shared discovery of public collections |
| **Testing** | Vitest + Testing Library + Playwright | Unit, component, E2E |

---

## Database Schema (Supabase PostgreSQL)

```sql
-- Auth handled by Supabase Auth (auth.users)

create table profiles (
  id uuid references auth.users primary key,
  display_name text,
  avatar_url text,
  created_at timestamptz default now()
);

create table recipe_collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references profiles(id) not null,
  title text not null,
  source_type text not null check (source_type in ('PUBLISHED_BOOK', 'PERSONAL', 'WEBSITE')),
  -- Cookbook fields
  author text,
  isbn text,
  publisher text,
  publication_year int,
  -- PersonalCollection fields
  description text,
  notes text,
  -- WebCollection fields
  source_url text,
  date_accessed date,
  site_name text,
  -- Metadata
  is_public boolean default false,
  forked_from uuid references recipe_collections(id) on delete set null,
  cover_image_path text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table recipes (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid references recipe_collections(id) on delete cascade not null,
  title text not null,
  servings_amount int,
  servings_description text,
  sort_order int not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid references recipes(id) on delete cascade not null,
  sort_order int not null,
  type text not null check (type in ('MEASURED', 'VAGUE')),
  name text not null,
  preparation text,
  notes text,
  -- Quantity fields (null for VagueIngredient)
  quantity_type text check (quantity_type in ('EXACT', 'FRACTIONAL', 'RANGE')),
  quantity_amount float,
  quantity_whole int,
  quantity_numerator int,
  quantity_denominator int,
  quantity_min float,
  quantity_max float,
  quantity_unit text
);

create table instructions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid references recipes(id) on delete cascade not null,
  step_number int not null,
  text text not null
);

create table instruction_ingredient_refs (
  instruction_id uuid references instructions(id) on delete cascade,
  ingredient_id uuid references ingredients(id) on delete cascade,
  primary key (instruction_id, ingredient_id)
);

create table conversion_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references profiles(id) not null,
  recipe_id uuid references recipes(id) on delete cascade, -- null = house rule
  from_unit text not null,
  to_unit text not null,
  factor float not null check (factor > 0),
  ingredient_name text, -- null = generic
  priority text not null check (priority in ('HOUSE', 'RECIPE', 'STANDARD'))
);

-- Table of Contents: public collections discoverable by all users
create view public_collections as
  select rc.id, rc.title, rc.source_type, rc.author, rc.cover_image_path,
         p.display_name as owner_name,
         count(r.id) as recipe_count
  from recipe_collections rc
  join profiles p on rc.owner_id = p.id
  left join recipes r on r.collection_id = rc.id
  where rc.is_public = true
  group by rc.id, p.display_name;

-- Row Level Security
alter table recipe_collections enable row level security;
alter table recipes enable row level security;
alter table ingredients enable row level security;
alter table instructions enable row level security;
alter table conversion_rules enable row level security;

-- Policies: users see their own data + public collections
create policy "Users see own collections" on recipe_collections
  for select using (owner_id = auth.uid() or is_public = true);
create policy "Users modify own collections" on recipe_collections
  for all using (owner_id = auth.uid());
-- (similar policies for recipes, ingredients, instructions, conversion_rules)
```

---

## Offline Sync Strategy

**Approach: Local-first with CRDT sync via cr-sqlite or PowerSync**

1. **Local SQLite** is the primary data store on every client. All reads and writes go to local SQLite first.
2. **Sync engine** runs in background, pushing local changes to Supabase and pulling remote changes.
3. **Conflict resolution:** Last-write-wins per field (sufficient for recipe data — recipe edits are infrequent and typically single-user). For shopping list checkboxes, use CRDT counters.
4. **Offline mode:** Full functionality without network. Sync resumes when connection returns.
5. **First load:** On sign-in, bulk download user's data from Supabase → local SQLite. Subsequent syncs are incremental (change tracking via `updated_at` timestamps + Supabase Realtime subscriptions).

**Sync boundaries:**
- User's own collections, recipes, ingredients, instructions, conversion rules: bidirectional sync
- Public table of contents: read-only pull (Edge Function API)
- Recipe images: lazy download, cached locally

---

## Table of Contents Service

A shared discovery mechanism for public recipe collections. Implemented entirely via Supabase views, RLS policies, and Postgres RPC functions — no Edge Functions needed.

**Browse:** The `public_collections` view (defined in schema above) is directly queryable by any authenticated client via Supabase's PostgREST API. RLS allows all authenticated users to read public collections. Filtering by `source_type`, searching by `title`/`author`, and pagination are handled by PostgREST query parameters (`?source_type=eq.PUBLISHED_BOOK&title=ilike.*chocolate*&limit=20&offset=0`).

**Preview:** A client reads a public collection's full recipe list via a normal join query — RLS permits reading recipes belonging to any public collection.

**Fork:** A Postgres RPC function handles the atomic copy:

```sql
create or replace function fork_collection(source_collection_id uuid)
returns uuid
language plpgsql
security definer
as $$
declare
  new_collection_id uuid;
begin
  -- Copy collection with new owner
  insert into recipe_collections (owner_id, title, source_type, author, isbn, publisher,
    publication_year, description, notes, source_url, date_accessed, site_name,
    is_public, forked_from)
  select auth.uid(), title, source_type, author, isbn, publisher,
    publication_year, description, notes, source_url, date_accessed, site_name,
    false, source_collection_id
  from recipe_collections
  where id = source_collection_id and is_public = true
  returning id into new_collection_id;

  if new_collection_id is null then
    raise exception 'Collection not found or not public';
  end if;

  -- Copy all recipes and their ingredients/instructions
  -- (uses INSERT ... SELECT with new IDs via gen_random_uuid())
  -- Implementation: copy recipes, then ingredients, then instructions,
  -- mapping old IDs to new IDs via a temp table or CTE chain

  return new_collection_id;
end;
$$;
```

Called from the client as: `supabase.rpc('fork_collection', { source_collection_id: '...' })`

---

## Feature Set

### Core Recipe Management
- [ ] Create, edit, delete recipes
- [ ] Rich ingredient editor (measured + vague, all quantity types)
- [ ] Instruction editor with ingredient references
- [ ] Recipe scaling with side-by-side comparison
- [ ] Unit conversion (full ConversionRegistry with HOUSE/RECIPE/STANDARD priorities)
- [ ] House conversion rules management

### Collections
- [ ] Create personal collections
- [ ] Import cookbooks (metadata: author, ISBN, publisher, year)
- [ ] Web collections (source URL, date accessed)
- [ ] Drag-and-drop recipe ordering within collections
- [ ] Collection cover images

### Import/Export
- [ ] Import from JSON (paste or file upload)
- [ ] Import from plain text (natural language ingredient parsing)
- [ ] Export to Markdown
- [ ] Share collection as public (table of contents)
- [ ] Fork public collections into your library

### Search and Discovery
- [ ] Search recipes by ingredient (case-insensitive substring)
- [ ] Search across all collections
- [ ] Browse public table of contents
- [ ] Filter by source type

### Shopping List
- [ ] Generate from multiple recipes
- [ ] Automatic ingredient aggregation (combine like items)
- [ ] Uncountable items section (VagueIngredients)
- [ ] Interactive checkboxes (persisted locally)

### Cook Mode
- [ ] Step-by-step instruction view
- [ ] Swipe/tap navigation between steps
- [ ] Current step highlighting
- [ ] Screen-awake lock
- [ ] Ingredient quantities displayed per step (IngredientRefs)

### User Account
- [ ] Email/password + social auth (Google, Apple, GitHub)
- [ ] Profile with display name and avatar
- [ ] Data export (full library as JSON)

---

## Project Structure

```
cookyourbooks/
├── packages/
│   ├── domain/                 # Pure TypeScript domain model (no framework deps)
│   │   ├── src/
│   │   │   ├── model/          # Quantity, Ingredient, Recipe, Collection types
│   │   │   ├── conversion/     # ConversionRule, ConversionRegistry, StandardConversions
│   │   │   ├── services/       # RecipeService, ShoppingList, parsing
│   │   │   └── export/         # MarkdownExporter
│   │   └── tests/
│   ├── db/                     # Database layer
│   │   ├── src/
│   │   │   ├── schema/         # SQLite schema, migrations
│   │   │   ├── repositories/   # RecipeRepository, CollectionRepository (SQLite impl)
│   │   │   └── sync/           # Supabase sync engine
│   │   └── tests/
│   └── ui/                     # React components (shared across all clients)
│       ├── src/
│       │   ├── components/     # RecipeCard, IngredientEditor, ScalingView, CookMode...
│       │   ├── pages/          # Home, CollectionView, RecipeDetail, Search, Settings...
│       │   ├── hooks/          # useRecipes, useCollections, useSync, useConversions...
│       │   └── stores/         # Zustand stores for UI state
│       └── tests/
├── apps/
│   ├── web/                    # Vite web app entry point
│   └── mobile/                 # Capacitor wrapper (iOS + Android)
├── supabase/
│   ├── migrations/             # PostgreSQL schema migrations (tables, views, RPC functions, RLS policies)
│   └── seed.sql                # Sample data (standard conversions, demo collections)
└── turbo.json                  # Turborepo config
```

---

## Implementation Phases

### Phase 1: Domain + Local App (4 weeks)
- Port domain model to TypeScript (`packages/domain`)
- Port all domain model tests (Vitest)
- Build local SQLite schema and repositories (`packages/db`)
- Build core UI components: recipe viewer, collection browser, ingredient editor
- Web app running locally (no sync, no auth)
- **Milestone:** Web app that can create, edit, scale, convert, and search recipes offline

### Phase 2: Web + Auth + Sync (3 weeks)
- Supabase project setup (auth, database, storage, RLS policies)
- Build sync engine (local SQLite ↔ Supabase PostgreSQL)
- Deploy web app (Vite → Vercel or Supabase hosting)
- Add auth flow (email + Google OAuth)
- Recipe image upload/display
- **Milestone:** Web app with accounts, sync, and full offline support

### Phase 3: Table of Contents + Social (2 weeks)
- "Make collection public" toggle in UI (sets `is_public` flag, RLS handles visibility)
- Table of contents browser querying `public_collections` view via PostgREST
- Search/filter via PostgREST query params (ilike, eq, limit/offset)
- Fork via `supabase.rpc('fork_collection', ...)` (Postgres RPC, atomic copy)
- **Milestone:** Users can discover, preview, and fork public recipe collections

### Phase 4: Cook Mode + Shopping List + Polish (2 weeks)
- Cook mode with step-by-step navigation and screen-awake lock
- Shopping list with multi-recipe aggregation and checkboxes
- Import from text (natural language ingredient parsing)
- Export to Markdown
- Keyboard shortcuts, accessibility audit, responsive design
- **Milestone:** Feature-complete app ready for beta

### Phase 5: Mobile + Launch (2 weeks)
- Capacitor wrapper for iOS and Android
- Native features: haptic feedback for cook mode, share sheet integration, home screen icon
- App Store / Play Store listing
- Landing page
- **Milestone:** Public launch on web + iOS + Android

---

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Monorepo with shared domain | Turborepo + packages/ | Domain logic tested once, shared across all clients |
| Local-first architecture | SQLite primary, Supabase sync | Offline support is a first-class requirement |
| Discriminated unions over class hierarchies | TypeScript idiom | Exhaustive switch/case, better serialization |
| Supabase over custom backend | Auth + DB + Storage + Realtime in one | Reduces ops burden; generous free tier |
| CRDT sync over custom conflict resolution | cr-sqlite or PowerSync | Battle-tested, handles offline merge correctly |
| Views + RLS + RPC over Edge Functions | PostgREST queries are simpler, faster, and cacheable | Avoids cold starts; keeps logic in Postgres where the data is; RPC for atomic multi-table operations (fork) |
