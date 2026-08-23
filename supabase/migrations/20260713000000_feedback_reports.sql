-- In-app feature requests / error reports, with the UI breadcrumbs that make
-- them actionable.
--
-- Before this, the only bug channel was a user describing the problem in prose:
-- no route history, no build id, no device, no log tail. A report row therefore
-- carries a `payload` blob (breadcrumb trail + sync-log tail + device context)
-- alongside the user's own words, and the client mirrors the same report into
-- Sentry so the two can be cross-referenced by id.
--
-- Shape follows the Data Usage events table (20260704000000) almost exactly:
--   * an ONLINE-only surface — read straight through PostgREST under RLS, not
--     via the local-first SQLite cache, so there is no sync-engine change here.
--   * household visibility is the claim-based compare (20260623000100 /
--     20260623000200): a denormalized `household_id` plus a consolidated
--     `_read` policy whose household branch is a pure JWT-claim-vs-column test.
--   * writes go through one security-definer RPC that stamps owner_id and
--     household_id from the caller's auth context, so a client can spoof
--     neither.
--
-- It adds one branch the telemetry tables don't have: admins can read every
-- report, because the whole point is that the developer receives them. That
-- branch reads the `is_admin` JWT claim (20260623000000) rather than calling
-- public.is_admin(), matching the claim-over-security-definer choice the
-- household policies made.

-- ============================================================
-- 1. table
-- ============================================================
create table if not exists public.feedback_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,                   -- stamped server-side = auth.uid()
  household_id uuid,                         -- denormalized from the JWT claim;
                                             -- NULL when not sharing. No FK —
                                             -- matches the 20260623000100 pattern.
  kind text not null check (kind in ('bug', 'feature')),
  body text not null check (length(btrim(body)) > 0),
  -- Breadcrumb trail, sync-log tail and device/build context. Free-form so the
  -- client can enrich it without a migration; capped by the RPC.
  payload jsonb not null default '{}'::jsonb,
  release text,                              -- VITE_SENTRY_RELEASE (build id)
  platform text,                             -- 'web' | 'capacitor-ios' | …
  route text,                                -- where the user was when filing
  -- Cross-reference to the Sentry event the client also sent, when it landed.
  sentry_event_id text,
  status text not null default 'new' check (status in ('new', 'triaged', 'closed')),
  created_at timestamptz not null default now()
);

create index if not exists feedback_reports_owner_created_idx
  on public.feedback_reports(owner_id, created_at desc);
create index if not exists feedback_reports_household_created_idx
  on public.feedback_reports(household_id, created_at desc)
  where household_id is not null;
-- Admin triage list: newest open reports first.
create index if not exists feedback_reports_status_created_idx
  on public.feedback_reports(status, created_at desc);

alter table public.feedback_reports enable row level security;

-- Own rows first (keeps the compare off the owner's own row, the Realtime
-- invariant the other consolidated policies preserve), then admins, then the
-- household claim-vs-column branch.
create policy "feedback_reports_read" on public.feedback_reports
  for select using (
    owner_id = (select auth.uid())
    or coalesce((auth.jwt() ->> 'is_admin')::boolean, false)
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );

-- Triage: only admins may move a report's status. No INSERT/DELETE policy —
-- inserts go through feedback_submit (security definer) below, and reports are
-- never deleted from the client.
create policy "feedback_reports_admin_update" on public.feedback_reports
  for update
  using (coalesce((auth.jwt() ->> 'is_admin')::boolean, false))
  with check (coalesce((auth.jwt() ->> 'is_admin')::boolean, false));

-- ============================================================
-- 2. refresh_household_denorm: re-stamp feedback_reports on a sharing
--    transition. Full re-emit of the CURRENT body plus the new line.
-- ============================================================
-- NOTE: this must stay in lockstep with the latest definition. The body below
-- is 20260709000000's verbatim, plus two lines:
--   * feedback_reports (new here);
--   * sync_transfer_events — which 20260704000000 added and 20260709000000
--     dropped when it re-emitted the body to remove the ingredients /
--     instructions / instruction_ingredient_refs tables. That drop was exactly
--     the silent regression 20260704000000's comment warned about, so it is
--     restored here: without it, a member toggling library sharing stops
--     re-stamping their historical Data Usage rows.
create or replace function public.refresh_household_denorm(p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_hh uuid;
begin
  set local statement_timeout = '120s';
  perform set_config('app.denorm_in_progress', 'on', true);
  v_hh := public.owner_shared_household(p_owner);
  update public.recipe_collections   set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipes              set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.cooking_events       set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipe_tags          set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.collection_notes     set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  -- LLM Cost Center cost tables:
  update public.import_item_attempts set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.bakeoff_variants     set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.rewrite_jobs         set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.misc_llm_usage       set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.remix_jobs           set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  -- Activity feed queues:
  update public.recipe_embedding_jobs set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipe_cover_jobs     set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  -- Data Usage transfer events:
  update public.sync_transfer_events set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  -- Feedback reports:
  update public.feedback_reports     set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  perform set_config('app.denorm_in_progress', '', true);
end;
$$;
revoke all on function public.refresh_household_denorm(uuid) from public, anon, authenticated;

-- ============================================================
-- 3. feedback_submit: the authenticated write path.
-- ============================================================
-- security definer so it can write past the read-only RLS, but every
-- identity column is taken from the caller's auth context, never the argument
-- list. Returns the new id so the client can tag the matching Sentry event
-- with it.
create or replace function public.feedback_submit(
  p_kind text,
  p_body text,
  p_payload jsonb default '{}'::jsonb,
  p_release text default null,
  p_platform text default null,
  p_route text default null,
  p_sentry_event_id text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_hh uuid := (auth.jwt() ->> 'household_id')::uuid;
  v_id uuid;
  v_body text := btrim(coalesce(p_body, ''));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if v_body = '' then
    raise exception 'feedback body required' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('bug', 'feature') then
    raise exception 'kind must be bug or feature' using errcode = '22023';
  end if;
  -- Keep one report from becoming an upload channel. Both limits are far above
  -- anything the client actually sends (a 100-entry breadcrumb trail plus a
  -- 200-line log tail lands well under 256 KB).
  if length(v_body) > 20000 then
    raise exception 'feedback body too long' using errcode = '22001';
  end if;
  if pg_column_size(v_payload) > 262144 then
    raise exception 'feedback payload too large' using errcode = '22001';
  end if;

  insert into public.feedback_reports (
    owner_id, household_id, kind, body, payload, release, platform, route, sentry_event_id
  ) values (
    v_owner, v_hh, p_kind, v_body, v_payload,
    nullif(btrim(coalesce(p_release, '')), ''),
    nullif(btrim(coalesce(p_platform, '')), ''),
    nullif(btrim(coalesce(p_route, '')), ''),
    nullif(btrim(coalesce(p_sentry_event_id, '')), '')
  )
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.feedback_submit(text, text, jsonb, text, text, text, text)
  from public, anon;
grant execute on function public.feedback_submit(text, text, jsonb, text, text, text, text)
  to authenticated;

-- The client selects the table directly under RLS (one table, no union to
-- project), so it needs the ordinary grants. RLS is what scopes the rows.
grant select on public.feedback_reports to authenticated;
grant update (status) on public.feedback_reports to authenticated;
