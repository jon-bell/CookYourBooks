-- Cooking tracker: cooking_events.
--
-- Records the act of cooking a recipe, not just storing it. One row per
-- planned-or-completed cook:
--   * PLANNED — "make this on <date>" (a future schedule entry).
--   * COOKED  — "I made this" (a history/diary entry).
-- A PLANNED row becomes COOKED with a plain column update (no RPC); the
-- local-first CRDT model already owns conflict resolution via updated_at,
-- exactly like a recipe edit.
--
-- Each event carries an occasion (a category token and/or free text), the
-- cook's notes, and a STRUCTURED diff of what they changed (`adjustments`,
-- a RecipeAdjustment[] validated app-side). COOKED events also carry a
-- lightweight `recipe_snapshot` so the diary stays readable forever — see
-- the recipe_id FK note below.
--
-- Sharing: an active household member's cooking activity is readable by
-- their co-members under the SAME library-sharing gate as recipes. The
-- read policy INLINES that gate (no viewer_can_read_owner_library() call):
-- per 20260611000000 / 20260616000000 a correlated per-row SECURITY
-- DEFINER call blew the 8s statement_timeout on a large shared library.
-- The non-correlated `owner_id in (select ...)` subquery is hoisted to a
-- single InitPlan (an O(1) hashed membership test per row). The leading
-- `owner_id <> (select auth.uid())` short-circuit MUST stay first so the
-- household subquery is never evaluated for the owner's own-row changes —
-- evaluating it there breaks Supabase Realtime delivery (see 20260609).

create table public.cooking_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  -- Nullable + ON DELETE SET NULL: cooked history survives recipe deletion.
  -- The recipe_snapshot keeps the entry readable once recipe_id goes null.
  recipe_id uuid references public.recipes(id) on delete set null,
  status text not null check (status in ('PLANNED', 'COOKED')),
  -- Day-granular (DATE, not timestamptz): a calendar entry is a day, it is
  -- timezone-stable across household members, and it range-queries cleanly.
  event_date date not null,
  -- App-level enum (MEAL / CELEBRATION / ...). No CHECK so adding a new
  -- category never needs a migration.
  occasion_category text,
  occasion_note text,
  notes text,
  -- Structured recipe diff: RecipeAdjustment[] (discriminated union tagged
  -- with `type`). Validated app-side; stored as jsonb.
  adjustments jsonb not null default '[]'::jsonb,
  -- Durable snapshot of the essential recipe graph at cook time (title +
  -- ingredients + instructions), populated client-side on COOKED. Null for
  -- PLANNED (a plan points at the live recipe).
  recipe_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index cooking_events_owner_idx on public.cooking_events(owner_id);
create index cooking_events_recipe_idx on public.cooking_events(recipe_id);
create index cooking_events_owner_date_idx on public.cooking_events(owner_id, event_date);
-- The owner watermark pull rides this (gte updated_at, ordered).
create index cooking_events_owner_updated_idx on public.cooking_events(owner_id, updated_at);

alter table public.cooking_events enable row level security;

-- Owner CRUD, split per verb (so USING isn't evaluated on SELECT) and with
-- auth.uid() wrapped as an InitPlan.
create policy "cooking_events_read_own" on public.cooking_events
  for select using (owner_id = (select auth.uid()));
create policy "cooking_events_insert_own" on public.cooking_events
  for insert with check (owner_id = (select auth.uid()));
create policy "cooking_events_update_own" on public.cooking_events
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "cooking_events_delete_own" on public.cooking_events
  for delete using (owner_id = (select auth.uid()));

-- Household read — INLINED, no function call. Same form as the flat
-- ingredients/instructions household policies in 20260616000000. The
-- IN-subquery is non-correlated -> one InitPlan; the short-circuit stays.
create policy "cooking_events_read_household" on public.cooking_events
  for select using (
    owner_id <> (select auth.uid())
    and owner_id in (
      select owner_m.user_id
      from public.household_members owner_m
      join public.household_members viewer_m
        on viewer_m.household_id = owner_m.household_id
      where owner_m.left_at is null
        and owner_m.library_shared = true
        and viewer_m.user_id = (select auth.uid())
        and viewer_m.left_at is null
    )
  );

create trigger cooking_events_updated
  before update on public.cooking_events
  for each row execute function public.touch_updated_at();

alter publication supabase_realtime add table public.cooking_events;
