-- Activity feed: a unified, online-only report of the caller's (and their
-- household co-members') async/batch jobs across the six worker queues —
-- bulk OCR import, model bake-off, instruction rewrite, recipe remix, recipe
-- embedding, and cover-image generation. Backs the /activity page, which
-- mirrors the LLM Cost Center: a security_invoker UNION view read directly via
-- PostgREST, RLS-scoped to the caller + their household.
--
-- This migration:
--   1. Gives recipe_embedding_jobs + recipe_cover_jobs the household
--      denormalization + claim-based read RLS the other four tables already
--      got from the cost-center migrations (20260625000000 / 20260628000000).
--      (rewrite_jobs, remix_jobs, bakeoff_variants, import_item_attempts are
--      already done; the OCR *batch* arm stays owner-only — see §3.)
--   2. Extends refresh_household_denorm to re-stamp the two new tables.
--   3. Defines the batch_jobs_report security_invoker view.
--   4. Adds the minimal cancel/retry RPC surface the page needs:
--      rewrite_retry, remix_retry, cover_cancel, cover_retry (rewrite_cancel
--      and remix_cancel already exist).
--
-- Template: 20260628000000_remix_cost_center.sql (same pattern, for remix_jobs).

-- ============================================================
-- 1. recipe_embedding_jobs — household_id + claim-based read
-- ============================================================
alter table public.recipe_embedding_jobs add column if not exists household_id uuid;

-- Backfill: household_id = the owner's active *sharing* household (NULL
-- otherwise). Mirrors the cost-center backfill; kept for idempotency.
update public.recipe_embedding_jobs t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;

drop trigger if exists recipe_embedding_jobs_set_household on public.recipe_embedding_jobs;
create trigger recipe_embedding_jobs_set_household
  before insert or update of owner_id on public.recipe_embedding_jobs
  for each row execute function public.set_owned_row_household();

create index if not exists recipe_embedding_jobs_household_idx
  on public.recipe_embedding_jobs(household_id) where household_id is not null;

-- Replace the owner-only SELECT policy with own + claim-based household read.
-- Own branch OR'd first so Realtime delivery of the owner's own rows never
-- evaluates the household compare. No write policies (unchanged): the queue is
-- written only by security-definer enqueue helpers + the service-role worker.
drop policy if exists "recipe_embedding_jobs_read_own" on public.recipe_embedding_jobs;
create policy "recipe_embedding_jobs_read" on public.recipe_embedding_jobs
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );

-- ============================================================
-- 2. recipe_cover_jobs — household_id + 3-branch read
-- ============================================================
alter table public.recipe_cover_jobs add column if not exists household_id uuid;

-- Visibility follows the recipe OWNER's sharing household (so a co-member sees
-- covers being generated against a shared recipe), so household_id is stamped
-- from owner_id, exactly like every other shared row.
update public.recipe_cover_jobs t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;

drop trigger if exists recipe_cover_jobs_set_household on public.recipe_cover_jobs;
create trigger recipe_cover_jobs_set_household
  before insert or update of owner_id on public.recipe_cover_jobs
  for each row execute function public.set_owned_row_household();

create index if not exists recipe_cover_jobs_household_idx
  on public.recipe_cover_jobs(household_id) where household_id is not null;

-- 3 branches: cover jobs are the only queue with a non-owner principal (the
-- initiator who launched + pays). Preserve requested_by + owner_id as
-- first-class own branches; the household compare is last and excludes both.
drop policy if exists "recipe_cover_jobs_read" on public.recipe_cover_jobs;
create policy "recipe_cover_jobs_read" on public.recipe_cover_jobs
  for select using (
    requested_by = (select auth.uid())
    or owner_id = (select auth.uid())
    or (
      requested_by <> (select auth.uid())
      and owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );

-- ============================================================
-- 3. extend refresh_household_denorm
-- ============================================================
-- CREATE OR REPLACE swaps the WHOLE function, so re-emit the authoritative
-- body from 20260628000000 verbatim (base tables + collection_notes + the four
-- cost tables + remix_jobs) and append the two new queues. Does NOT bump any
-- updated_at.
create or replace function public.refresh_household_denorm(p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_hh uuid;
begin
  set local statement_timeout = '120s';
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
end;
$$;
revoke all on function public.refresh_household_denorm(uuid) from public, anon, authenticated;

-- ============================================================
-- 4. batch_jobs_report view (security_invoker)
-- ============================================================
-- One row per job, normalized to a common shape. security_invoker so the
-- base-table RLS (own + household claim) filters as the caller — a definer
-- view would leak every household's jobs. Unlike llm_usage_report it does NOT
-- filter to terminal statuses: in-flight jobs are the whole point.
--
-- Status is normalized to pending | running | done | failed. target_kind +
-- target_id let the client deep-link (recipe page / import batch) and resolve a
-- title from its local cache. pending/done/failed_count are populated only for
-- the OCR arm (one row per batch); NULL elsewhere.
drop view if exists public.batch_jobs_report;
create view public.batch_jobs_report with (security_invoker = true) as
  -- bulk OCR import — aggregated to one row per batch (per-item would flood the
  -- feed and duplicate /import). import_batches/import_items are owner-only, so
  -- under security_invoker this arm is naturally the caller's own batches
  -- (household_id = NULL); co-member OCR is intentionally not surfaced here.
  select
    'ocr'::text                                                                 as kind,
    b.id                                                                        as id,
    b.owner_id                                                                  as owner_id,
    null::uuid                                                                  as household_id,
    b.owner_id                                                                  as requested_by,
    case
      when count(*) filter (where i.status in ('PENDING', 'CLAIMED', 'NEEDS_FALLBACK')) > 0 then 'running'
      when count(*) filter (where i.status = 'OCR_FAILED') > 0 then 'failed'
      else 'done'
    end                                                                         as status,
    b.created_at                                                                as created_at,
    greatest(b.updated_at, max(i.updated_at))                                   as updated_at,
    null::int                                                                   as attempts,
    null::text                                                                  as last_error,
    'batch'::text                                                               as target_kind,
    b.id::text                                                                  as target_id,
    count(*) filter (where i.status in ('PENDING', 'CLAIMED', 'NEEDS_FALLBACK'))::int as pending_count,
    count(*) filter (where i.status in ('OCR_DONE', 'REVIEWED'))::int           as done_count,
    count(*) filter (where i.status = 'OCR_FAILED')::int                        as failed_count
  from public.import_batches b
  join public.import_items i on i.batch_id = b.id and i.status <> 'DISCARDED'
  group by b.id

  union all
  -- model bake-off variants (each variant is a row; client groups by run_id)
  select
    'bakeoff', v.id, v.owner_id, v.household_id, v.owner_id,
    case v.status when 'PENDING' then 'pending' when 'CLAIMED' then 'running'
                  when 'DONE' then 'done' else 'failed' end,
    v.created_at, v.updated_at, v.attempts, coalesce(v.error_message, v.error_kind),
    null::text, v.run_id::text,
    null::int, null::int, null::int
  from public.bakeoff_variants v

  union all
  -- instruction rewrites
  select
    'rewrite', j.id, j.owner_id, j.household_id, j.owner_id,
    case j.status when 'PENDING' then 'pending' when 'CLAIMED' then 'running'
                  when 'DONE' then 'done' else 'failed' end,
    j.created_at, j.updated_at, j.attempts, j.last_error,
    'recipe'::text, j.recipe_id::text,
    null::int, null::int, null::int
  from public.rewrite_jobs j

  union all
  -- recipe remix
  select
    'remix', r.id, r.owner_id, r.household_id, r.owner_id,
    case r.status when 'PENDING' then 'pending' when 'CLAIMED' then 'running'
                  when 'DONE' then 'done' else 'failed' end,
    r.created_at, r.updated_at, r.attempts, r.last_error,
    'recipe'::text, r.recipe_id::text,
    null::int, null::int, null::int
  from public.remix_jobs r

  union all
  -- recipe embeddings (maintenance jobs; client surfaces only non-done ones)
  select
    'embedding', e.id, e.owner_id, e.household_id, e.owner_id,
    case e.status when 'PENDING' then 'pending' when 'CLAIMED' then 'running'
                  when 'DONE' then 'done' else 'failed' end,
    e.created_at, e.updated_at, e.attempts, e.last_error,
    'recipe'::text, e.recipe_id::text,
    null::int, null::int, null::int
  from public.recipe_embedding_jobs e

  union all
  -- cover-image generation
  select
    'cover', c.id, c.owner_id, c.household_id, c.requested_by,
    case c.status when 'PENDING' then 'pending' when 'CLAIMED' then 'running'
                  when 'DONE' then 'done' else 'failed' end,
    c.created_at, c.updated_at, c.attempts, c.last_error,
    'recipe'::text, c.recipe_id::text,
    null::int, null::int, null::int
  from public.recipe_cover_jobs c;

grant select on public.batch_jobs_report to authenticated;

-- ============================================================
-- 5. cancel / retry RPCs for the Activity page
-- ============================================================
-- rewrite_cancel + remix_cancel already exist (20260604000001 / 20260627000000).
-- Retry resets a caller-owned FAILED job back to PENDING (reusing its stored
-- config) and best-effort kicks the worker; if the worker isn't configured the
-- kick is swallowed and the 30s cron tick drains the requeued job. Cancel flips
-- a PENDING/CLAIMED job to FAILED 'CANCELLED'.

-- ---------- rewrite_retry ----------
create or replace function public.rewrite_retry(p_job_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  caller uuid := auth.uid();
  job_owner uuid;
  job_recipe uuid;
begin
  if caller is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select owner_id, recipe_id into job_owner, job_recipe from public.rewrite_jobs where id = p_job_id;
  if job_owner is null then return false; end if;
  if job_owner <> caller then raise exception 'Not owner of job' using errcode = '42501'; end if;
  update public.rewrite_jobs
    set status = 'PENDING', claim_token = null, last_error = null,
        claim_expires_at = 'epoch'::timestamptz, updated_at = now()
    where id = p_job_id and status = 'FAILED';
  if not found then return false; end if;
  begin
    perform public.rewrite_kick(job_recipe);
  exception when others then null; -- unconfigured worker / transient: cron drains it
  end;
  return true;
end;
$$;
revoke all on function public.rewrite_retry(uuid) from public, anon;
grant execute on function public.rewrite_retry(uuid) to authenticated;

-- ---------- remix_retry ----------
create or replace function public.remix_retry(p_job_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  caller uuid := auth.uid();
  job_owner uuid;
  job_recipe uuid;
begin
  if caller is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select owner_id, recipe_id into job_owner, job_recipe from public.remix_jobs where id = p_job_id;
  if job_owner is null then return false; end if;
  if job_owner <> caller then raise exception 'Not owner of job' using errcode = '42501'; end if;
  update public.remix_jobs
    set status = 'PENDING', claim_token = null, last_error = null,
        claim_expires_at = 'epoch'::timestamptz, updated_at = now()
    where id = p_job_id and status = 'FAILED';
  if not found then return false; end if;
  begin
    perform public.remix_kick(job_recipe);
  exception when others then null;
  end;
  return true;
end;
$$;
revoke all on function public.remix_retry(uuid) from public, anon;
grant execute on function public.remix_retry(uuid) to authenticated;

-- ---------- cover_cancel ----------
create or replace function public.cover_cancel(p_job_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  caller uuid := auth.uid();
  v_owner uuid;
  v_requested uuid;
begin
  if caller is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select owner_id, requested_by into v_owner, v_requested
    from public.recipe_cover_jobs where id = p_job_id;
  if v_owner is null then return false; end if;
  if caller <> v_owner and caller <> v_requested then
    raise exception 'Not authorized for job' using errcode = '42501';
  end if;
  update public.recipe_cover_jobs
    set status = 'FAILED', last_error = 'CANCELLED', claim_token = null
    where id = p_job_id and status in ('PENDING', 'CLAIMED');
  return found;
end;
$$;
revoke all on function public.cover_cancel(uuid) from public, anon;
grant execute on function public.cover_cancel(uuid) to authenticated;

-- ---------- cover_retry ----------
create or replace function public.cover_retry(p_job_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  caller uuid := auth.uid();
  v_owner uuid;
  v_requested uuid;
  v_recipe uuid;
begin
  if caller is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select owner_id, requested_by, recipe_id into v_owner, v_requested, v_recipe
    from public.recipe_cover_jobs where id = p_job_id;
  if v_owner is null then return false; end if;
  if caller <> v_owner and caller <> v_requested then
    raise exception 'Not authorized for job' using errcode = '42501';
  end if;
  -- Respect the (recipe_id) one-pending partial unique index: if another job
  -- for this recipe is already queued, just wake the worker (idempotent).
  if exists (
    select 1 from public.recipe_cover_jobs
      where recipe_id = v_recipe and status in ('PENDING', 'CLAIMED') and id <> p_job_id
  ) then
    begin perform public.cover_kick(); exception when others then null; end;
    return true;
  end if;
  update public.recipe_cover_jobs
    set status = 'PENDING', claim_token = null, last_error = null,
        claim_expires_at = 'epoch'::timestamptz, updated_at = now()
    where id = p_job_id and status = 'FAILED';
  if not found then return false; end if;
  begin perform public.cover_kick(); exception when others then null; end;
  return true;
end;
$$;
revoke all on function public.cover_retry(uuid) from public, anon;
grant execute on function public.cover_retry(uuid) to authenticated;

analyze public.recipe_embedding_jobs;
analyze public.recipe_cover_jobs;
