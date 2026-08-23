-- Interaction signals: the two things we log but have never captured — what a
-- user searched for and which result they opened, and which auto-suggested
-- match they accepted vs. corrected.
--
-- Motivation is training data, not reporting. Every existing telemetry surface
-- here (LLM Cost Center 20260625000000, Data Usage 20260704000000) measures
-- what we *spent*; none of them capture the human judgement that would let us
-- fine-tune the on-device models — a domain-adapted embedder (query → clicked
-- recipe pairs) and a two-tower nutrition matcher (ingredient string → the food
-- row the user actually confirmed). Those labels only exist if we start
-- writing them down now.
--
-- Shape follows sync_transfer_events almost exactly:
--   * append-only event tables, no UPDATE/DELETE policy;
--   * writes go through a single security-definer RPC that stamps owner_id
--     from the caller's auth context, so a client can never spoof an owner;
--   * the client buffers and batches, so one flush = one round trip.
--
-- ONE DELIBERATE DIVERGENCE: there is no denormalized `household_id` and no
-- household branch in the read policy. Every other event table in this schema
-- is household-visible; search queries and per-ingredient corrections are
-- personal in a way that byte counts and model spend are not, and a household
-- is a household, not a consent boundary. These rows are OWNER-ONLY. That also
-- means these tables are deliberately absent from refresh_household_denorm —
-- nothing to re-stamp on a sharing transition.

-- ============================================================
-- 1. table: search_events
-- ============================================================
-- Two row kinds sharing one table, joined on the client-minted `query_id`
-- (same trick as sync_transfer_events.cycle_id):
--
--   kind='query' — one row per search that actually executed. Fat row: the
--                  text, which engine served it, how many hits came back.
--   kind='open'  — one row per result the user then clicked. Thin row: which
--                  recipe, at what rank, with what cosine.
--
-- A 'query' with no matching 'open' is a negative example and is just as
-- valuable as a positive one, which is why the two are separate rows rather
-- than a nullable column set updated in place.
create table if not exists public.search_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,                   -- stamped server-side = auth.uid()
  query_id uuid not null,                   -- links an 'open' back to its 'query'
  kind text not null check (kind in ('query', 'open')),

  -- ---- kind='query' columns ----
  query text not null default '',           -- the trimmed search text as typed
  mode text not null default ''             -- which engine actually served it
    check (mode in ('', 'semantic', 'substring')),
  result_count integer not null default 0,
  truncated boolean not null default false, -- hit the SEARCH_LIMIT render cap
  -- Why semantic may not have run. Lets us exclude cold-cache sessions from a
  -- training set instead of mistaking them for "semantic ranked this badly".
  embedder_status text not null default ''
    check (embedder_status in ('', 'idle', 'loading', 'ready', 'unavailable')),
  embedded_count integer not null default 0,
  -- ---- kind='open' columns ----
  -- The collection-type filter in force ('' = All collections). It lives on
  -- the 'open' row, not the 'query' row: the filter is a client-side
  -- post-filter applied after the search returns, so `result_count` above is
  -- the PRE-filter total while `opened_rank` below is the position in the
  -- filtered list the user actually saw. A training set needs both.
  source_filter text not null default '',
  opened_recipe_id uuid,                    -- no FK: the label must survive the
                                            -- recipe being deleted or re-imported
  opened_rank integer,                      -- 0-based position in the rendered list
  opened_score real,                        -- cosine for a semantic hit, null for literal

  created_at timestamptz not null default now()
);

create index if not exists search_events_owner_created_idx
  on public.search_events(owner_id, created_at desc);
-- The training-set join: every 'open' for a given query.
create index if not exists search_events_query_idx
  on public.search_events(query_id, kind);

alter table public.search_events enable row level security;

-- Owner-only. No household branch (see the header note). The `select auth.uid()`
-- wrapping is the initplan form used everywhere since 20260616000000.
create policy "search_events_read" on public.search_events
  for select using (owner_id = (select auth.uid()));
-- No INSERT/UPDATE/DELETE policy: rows are written only by
-- record_search_events (security definer) below, and pruned by the retention
-- job. Users delete theirs by deleting their account (FK-less by design, so
-- see the explicit cleanup in 3b).

-- ============================================================
-- 2. table: suggestion_events
-- ============================================================
-- One row per "we proposed something, here's what the human did about it".
-- Deliberately generic over `surface` so the next suggestion UI reuses it
-- rather than minting a third table.
--
-- `candidates` is the ranked list we showed, so the row is a complete training
-- triple — (input, candidate set, chosen) — without needing to re-run the
-- ranker later against a corpus that has since changed. Kept to keys + labels;
-- it is never big enough to warrant its own table.
create table if not exists public.suggestion_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,                   -- stamped server-side = auth.uid()
  surface text not null
    check (surface in ('nutrition_match', 'tag')),
  action text not null
    check (action in (
      'auto',       -- we picked one with no human in the loop (impression)
      'accepted',   -- human confirmed the thing we ranked first
      'corrected',  -- human picked a DIFFERENT candidate — the useful one
      'cleared'     -- human threw the mapping away entirely
    )),
  -- The model input: the raw ingredient string, or the tag prefix typed.
  input_text text not null default '',
  -- Stable identity of a candidate, not its display text:
  --   nutrition_match → 'USDA_FDC|171287'
  --   tag             → the normalized label
  suggested_key text not null default '',   -- what we ranked first ('' if nothing)
  chosen_key text not null default '',      -- what the human took ('' for 'cleared')
  -- 0-based rank of chosen_key within `candidates`; null when the human went
  -- off-list (typed a brand-new tag, or searched a fresh term in the dialog).
  -- Distinguishing "picked #4" from "rejected the whole list" matters.
  chosen_rank integer,
  candidates jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists suggestion_events_owner_created_idx
  on public.suggestion_events(owner_id, created_at desc);
-- The training query: "every correction on the nutrition matcher".
create index if not exists suggestion_events_surface_action_idx
  on public.suggestion_events(surface, action, created_at desc);

alter table public.suggestion_events enable row level security;

create policy "suggestion_events_read" on public.suggestion_events
  for select using (owner_id = (select auth.uid()));

-- ============================================================
-- 3. write RPCs (security definer, batched)
-- ============================================================
-- Both take a JSONB array so the client's buffer flushes in one round trip.
-- Both are defensive about missing/extra keys: a signal is never worth failing
-- a user action over, so an unparseable payload degrades to "nothing recorded"
-- rather than raising. The CHECK constraints stay as the backstop for values
-- that ARE present but wrong — a typo'd mode should surface, not hide.

create or replace function public.record_search_events(p_events jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_event jsonb;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  -- Tolerate a NULL / non-array payload as "nothing to record".
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return;
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    -- A row without a query_id can't be joined to anything, so it has no
    -- training value; skip rather than minting a synthetic id that would look
    -- like a real orphan later.
    continue when (v_event->>'query_id') is null;

    insert into public.search_events (
      owner_id, query_id, kind,
      query, mode, result_count, truncated,
      embedder_status, embedded_count, source_filter,
      opened_recipe_id, opened_rank, opened_score
    ) values (
      v_owner,
      (v_event->>'query_id')::uuid,
      coalesce(v_event->>'kind', 'query'),
      coalesce(v_event->>'query', ''),
      coalesce(v_event->>'mode', ''),
      coalesce((v_event->>'result_count')::integer, 0),
      coalesce((v_event->>'truncated')::boolean, false),
      coalesce(v_event->>'embedder_status', ''),
      coalesce((v_event->>'embedded_count')::integer, 0),
      coalesce(v_event->>'source_filter', ''),
      (v_event->>'opened_recipe_id')::uuid,
      (v_event->>'opened_rank')::integer,
      (v_event->>'opened_score')::real
    );
  end loop;
end;
$$;
revoke all on function public.record_search_events(jsonb) from public, anon;
grant execute on function public.record_search_events(jsonb) to authenticated;

create or replace function public.record_suggestion_events(p_events jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_event jsonb;
  v_candidates jsonb;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return;
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    continue when (v_event->>'surface') is null or (v_event->>'action') is null;

    -- The column is `jsonb not null default '[]'`; a client that sends an
    -- object or a scalar would otherwise store something no consumer expects.
    v_candidates := v_event->'candidates';
    if v_candidates is null or jsonb_typeof(v_candidates) <> 'array' then
      v_candidates := '[]'::jsonb;
    end if;

    insert into public.suggestion_events (
      owner_id, surface, action, input_text,
      suggested_key, chosen_key, chosen_rank, candidates
    ) values (
      v_owner,
      v_event->>'surface',
      v_event->>'action',
      coalesce(v_event->>'input_text', ''),
      coalesce(v_event->>'suggested_key', ''),
      coalesce(v_event->>'chosen_key', ''),
      (v_event->>'chosen_rank')::integer,
      v_candidates
    );
  end loop;
end;
$$;
revoke all on function public.record_suggestion_events(jsonb) from public, anon;
grant execute on function public.record_suggestion_events(jsonb) to authenticated;

-- ---- 3b. account deletion ----
-- These tables carry owner_id with no FK to profiles (matching the denorm
-- pattern), so an account delete won't cascade into them on its own. Hook the
-- cleanup onto profiles the same way, via a BEFORE DELETE trigger, so "delete
-- my account" in the Data & deletion tab really does take the signals with it.
create or replace function public.delete_interaction_signals_for_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.search_events where owner_id = old.id;
  delete from public.suggestion_events where owner_id = old.id;
  return old;
end;
$$;

drop trigger if exists profiles_delete_interaction_signals on public.profiles;
create trigger profiles_delete_interaction_signals
  before delete on public.profiles
  for each row execute function public.delete_interaction_signals_for_profile();

-- ============================================================
-- 4. retention
-- ============================================================
-- 180 days. Long enough to assemble a training set across a full seasonal
-- cycle of cooking, short enough that the privacy policy's retention table can
-- state a real number. Kept as a callable function (not just a cron body) so
-- it can be run by hand and unit-tested.
create or replace function public.prune_interaction_signals(
  p_before timestamptz default now() - interval '180 days'
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_deleted integer := 0;
  v_n integer;
begin
  delete from public.search_events where created_at < p_before;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;
  delete from public.suggestion_events where created_at < p_before;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;
  return v_deleted;
end;
$$;
revoke all on function public.prune_interaction_signals(timestamptz) from public, anon, authenticated;

-- Daily prune. Wrapped in DO so an install without pg_cron still applies the
-- migration cleanly (same pattern as the import-worker tick in 20260522000000).
do $$ begin
  perform cron.schedule(
    'prune-interaction-signals',
    '17 4 * * *',
    $cron$ select public.prune_interaction_signals(); $cron$
  );
exception when others then null;
end $$;

analyze public.search_events;
analyze public.suggestion_events;
