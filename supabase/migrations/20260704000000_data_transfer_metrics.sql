-- Data Usage reporting surface: a household-visible, read-only report over the
-- byte/row/request volume each sync cycle moved between the client and Supabase.
--
-- This mirrors the LLM Cost Center (20260625000000) almost exactly:
--   * an ONLINE-only reporting surface — the page reads a security_invoker view
--     (data_transfer_report) + a security_invoker rollup RPC
--     (data_transfer_summary) directly via PostgREST, NOT through the
--     local-first SQLite cache. So there is no sync-engine read change here.
--   * household visibility reuses the claim-based RLS machinery
--     (20260623000100 / 20260623000200): the events table carries a
--     denormalized `household_id` and a consolidated `_read` policy whose
--     household branch is a pure JWT-claim-vs-column compare. Visibility
--     therefore follows the owner's library-sharing flag automatically
--     (household_id is NULL when the owner isn't sharing).
--
-- The WRITE path differs from the cost center: the sync engine records its own
-- per-cycle transfer events client-side (it knows exactly what it pulled/pushed),
-- so writes go through a single security-definer RPC (record_sync_transfer)
-- called by the authenticated user. The RPC stamps owner_id + household_id from
-- the caller's auth context, so the client can never spoof either.

-- ============================================================
-- 1. table: sync_transfer_events (one row per cycle phase per direction)
-- ============================================================
create table if not exists public.sync_transfer_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,                  -- stamped server-side = auth.uid()
  household_id uuid,                        -- denormalized; stamped from the JWT
                                            -- household_id claim at insert time
                                            -- (NULL when not in a sharing
                                            -- household). No FK — matches the
                                            -- 20260623000100 denorm pattern.
  cycle_id uuid not null,                   -- groups the phases of one sync cycle
  direction text not null check (direction in ('pull', 'push')),
  phase text not null,                      -- 'recipes' | 'collections' |
                                            -- 'snapshot_meta' | 'snapshot_bodies' |
                                            -- 'imports' | 'push' | 'total' | …
  rows integer not null default 0,
  bytes bigint not null default 0,
  duration_ms integer not null default 0,
  requests integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists sync_transfer_events_owner_created_idx
  on public.sync_transfer_events(owner_id, created_at desc);
create index if not exists sync_transfer_events_household_created_idx
  on public.sync_transfer_events(household_id, created_at desc);

alter table public.sync_transfer_events enable row level security;

-- Consolidated SELECT policy: own rows OR (someone else's row whose
-- denormalized household_id matches MY JWT household_id claim). The `own`
-- branch is OR'd FIRST and the household branch keeps
-- `owner_id <> (select auth.uid())` as its first AND-term — the exact
-- claim-vs-column compare used by the cost center's `_read` policies
-- (mirrors import_item_attempts_read / misc_llm_usage_read). The household
-- compare reads the viewer's household straight off the JWT claim stamped by
-- custom_access_token_hook (20260623000000); no household_members self-join,
-- no security-definer call. Visibility follows library_shared automatically
-- because household_id is NULL on the row whenever the owner isn't sharing.
create policy "sync_transfer_events_read" on public.sync_transfer_events
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );
-- No INSERT/UPDATE/DELETE policy: rows are written only by
-- record_sync_transfer (security definer) below.

-- ============================================================
-- 2. extend refresh_household_denorm to re-stamp sync_transfer_events on a
--    sharing transition (full re-emit of the current body + 1 line), so a
--    member toggling library sharing on/off re-stamps their historical
--    transfer rows the same way the cost tables are re-stamped.
-- ============================================================
-- NOTE: this body must stay in lockstep with the latest definition
-- (20260701000100_denorm_skip_side_effects) — re-emitting a stale body via
-- CREATE OR REPLACE would silently regress the function. It is the current
-- body verbatim, plus the one `sync_transfer_events` line. In particular it
-- preserves the `app.denorm_in_progress` guard (20260701000100) and every
-- table/queue added since the cost center.
create or replace function public.refresh_household_denorm(p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_hh uuid;
begin
  set local statement_timeout = '120s';
  perform set_config('app.denorm_in_progress', 'on', true);
  v_hh := public.owner_shared_household(p_owner);
  update public.recipe_collections          set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipes                      set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.ingredients                  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.instructions                 set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.instruction_ingredient_refs  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.cooking_events               set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipe_tags                  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.collection_notes             set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  -- LLM Cost Center cost tables:
  update public.import_item_attempts         set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.bakeoff_variants             set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.rewrite_jobs                 set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.misc_llm_usage               set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.remix_jobs                   set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  -- Activity feed queues:
  update public.recipe_embedding_jobs        set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipe_cover_jobs            set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  -- Data Usage transfer events:
  update public.sync_transfer_events         set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  perform set_config('app.denorm_in_progress', '', true);
end;
$$;
revoke all on function public.refresh_household_denorm(uuid) from public, anon, authenticated;

-- ============================================================
-- 3. record_sync_transfer: the authenticated write path. The sync engine
--    batches one cycle's phases into a JSONB array and calls this once per
--    cycle. security definer so it can write past the (read-only) RLS, but it
--    stamps owner_id + household_id from the CALLER's auth context so a client
--    can neither spoof another owner nor inflate household visibility. Be
--    defensive about missing/extra keys (coalesce + ->> with casts).
-- ============================================================
create or replace function public.record_sync_transfer(
  p_cycle_id uuid,
  p_events jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  -- household_id straight off the JWT claim: NULL when the caller isn't in a
  -- sharing household, exactly matching the denorm value on the shared tables.
  v_hh uuid := (auth.jwt() ->> 'household_id')::uuid;
  v_event jsonb;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_cycle_id is null then
    raise exception 'cycle_id required' using errcode = '22023';
  end if;
  -- Tolerate a NULL / non-array payload as "nothing to record".
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return;
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    insert into public.sync_transfer_events (
      owner_id, household_id, cycle_id,
      direction, phase, rows, bytes, duration_ms, requests
    ) values (
      v_owner,
      v_hh,
      p_cycle_id,
      -- direction is CHECK-constrained to pull|push. A missing key defaults to
      -- 'pull'; any other non-null value (e.g. typo'd direction) flows through
      -- and trips the CHECK, surfacing the bad payload rather than hiding it.
      coalesce(v_event->>'direction', 'pull'),
      coalesce(v_event->>'phase', 'total'),
      coalesce((v_event->>'rows')::integer, 0),
      coalesce((v_event->>'bytes')::bigint, 0),
      coalesce((v_event->>'duration_ms')::integer, 0),
      coalesce((v_event->>'requests')::integer, 0)
    );
  end loop;
end;
$$;
revoke all on function public.record_sync_transfer(uuid, jsonb) from public, anon;
grant execute on function public.record_sync_transfer(uuid, jsonb) to authenticated;

-- ============================================================
-- 4. the reporting view (security_invoker: base-table RLS does own+household
--    filtering as the caller). A friendly projection over every useful column.
-- ============================================================
drop view if exists public.data_transfer_report;
create view public.data_transfer_report with (security_invoker = true) as
  select
    e.id,
    e.owner_id,
    e.household_id,
    e.cycle_id,
    e.direction,
    e.phase,
    coalesce(e.rows, 0)        as rows,
    coalesce(e.bytes, 0)::bigint as bytes,
    coalesce(e.duration_ms, 0) as duration_ms,
    coalesce(e.requests, 0)    as requests,
    e.created_at
  from public.sync_transfer_events e;

grant select on public.data_transfer_report to authenticated;

-- ============================================================
-- 5. rollup RPC (security INVOKER — reads the table under the caller's RLS,
--    so it cannot leak another household's transfer volume even as an RPC).
--    Groups [p_from, p_to) by one of 'day' | 'direction' | 'phase'.
-- ============================================================
create or replace function public.data_transfer_summary(
  p_group_by text default 'day',           -- 'day' | 'direction' | 'phase'
  p_from timestamptz default null,
  p_to timestamptz default null
) returns table (
  bucket text,
  rows bigint,
  bytes bigint,
  requests bigint,
  duration_ms bigint,
  event_count bigint
)
language sql stable security invoker set search_path = public as $$
  select
    case
      when p_group_by = 'direction' then e.direction
      when p_group_by = 'phase'     then e.phase
      else to_char(date_trunc('day', e.created_at), 'YYYY-MM-DD')  -- 'day' (default + fallback)
    end as bucket,
    sum(e.rows)::bigint        as rows,
    sum(e.bytes)::bigint       as bytes,
    sum(e.requests)::bigint    as requests,
    sum(e.duration_ms)::bigint as duration_ms,
    count(*)::bigint           as event_count
  from public.sync_transfer_events e
  where (p_from is null or e.created_at >= p_from)
    and (p_to is null or e.created_at < p_to)
  -- p_group_by is validated by the CASE above: only 'direction' and 'phase'
  -- pick those columns; every other value (incl. 'day', NULL, junk) buckets
  -- by day. So the function is total over the input — no error path needed.
  group by 1;
$$;
grant execute on function public.data_transfer_summary(text, timestamptz, timestamptz) to authenticated;

analyze public.sync_transfer_events;
