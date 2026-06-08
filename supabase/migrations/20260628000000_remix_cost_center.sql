-- LLM Cost Center: wire in Recipe Remix.
--
-- remix_jobs (20260627000000) is a fifth LLM-spend source. It gets the same
-- household-denormalization + claim-based RLS as the other cost tables
-- (mirrors 20260625000000) and a fifth branch on the llm_usage_report view,
-- so remix spend surfaces on /cost for the remixer and — when library
-- sharing is on — their household co-members, all under invoker RLS.

-- ============================================================
-- 1. denormalized household_id column
-- ============================================================
alter table public.remix_jobs add column if not exists household_id uuid;

-- backfill: household_id = the owner's active *sharing* household (NULL
-- otherwise). No-op on a fresh table; kept for parity/idempotency.
update public.remix_jobs t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;

-- ============================================================
-- 2. write-time household_id trigger (reuse set_owned_row_household)
-- ============================================================
drop trigger if exists remix_jobs_set_household on public.remix_jobs;
create trigger remix_jobs_set_household
  before insert or update of owner_id on public.remix_jobs
  for each row execute function public.set_owned_row_household();

-- ============================================================
-- 3. extend refresh_household_denorm to re-stamp remix_jobs on a sharing
--    transition. CREATE OR REPLACE replaces the WHOLE function, so this is
--    the authoritative final version: it must re-emit every table any prior
--    migration stamped. That means the base tables + collection_notes (added
--    by 20260625000100, which dropped the cost-table lines) + the four cost
--    tables (20260625000000) + remix_jobs. Does NOT bump any updated_at.
-- ============================================================
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
end;
$$;
revoke all on function public.refresh_household_denorm(uuid) from public, anon, authenticated;

-- ============================================================
-- 4. consolidated RLS (replace the FOR ALL baseline with own + household
--    read; own-only writes). Own-branch is OR'd first so Realtime delivery
--    of the owner's own rows never evaluates the household compare.
-- ============================================================
drop policy if exists "remix_jobs_own_all" on public.remix_jobs;
create policy "remix_jobs_read" on public.remix_jobs
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );
create policy "remix_jobs_insert_own" on public.remix_jobs
  for insert with check (owner_id = (select auth.uid()));
create policy "remix_jobs_update_own" on public.remix_jobs
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "remix_jobs_delete_own" on public.remix_jobs
  for delete using (owner_id = (select auth.uid()));

-- ============================================================
-- 5. household partial index
-- ============================================================
create index if not exists remix_jobs_household_idx
  on public.remix_jobs(household_id) where household_id is not null;

-- ============================================================
-- 6. reporting view: re-emit all four existing branches verbatim + a fifth
--    for remix_jobs. security_invoker, so base-table RLS does own+household
--    filtering as the caller.
-- ============================================================
drop view if exists public.llm_usage_report;
create view public.llm_usage_report with (security_invoker = true) as
  -- bulk OCR attempts
  select
    a.id,
    'ocr'::text                              as feature,
    a.owner_id,
    a.household_id,
    a.provider,
    a.model,
    coalesce(a.prompt_tokens, 0)             as prompt_tokens,
    coalesce(a.completion_tokens, 0)         as completion_tokens,
    coalesce(a.cost_usd_micros, 0)::bigint   as cost_usd_micros,
    coalesce(a.latency_ms, 0)                as latency_ms,
    a.error_kind,
    (a.error_kind = 'OK')                    as succeeded,
    coalesce(a.key_owner_id, a.owner_id)     as key_owner_id,
    k.key_fingerprint,
    a.item_id::text                          as produced_ref,
    'IMPORT_ITEM'::text                      as produced_kind,
    coalesce(a.started_at, a.finished_at)    as created_at
  from public.import_item_attempts a
  left join public.user_ocr_keys k
    on k.owner_id = coalesce(a.key_owner_id, a.owner_id) and k.provider = a.provider

  union all
  -- model bake-off variants (always the owner's own key)
  select
    v.id,
    'bakeoff'::text,
    v.owner_id,
    v.household_id,
    v.provider,
    v.model,
    coalesce(v.prompt_tokens, 0),
    coalesce(v.completion_tokens, 0),
    coalesce(v.cost_usd_micros, 0)::bigint,
    coalesce(v.latency_ms, 0),
    v.error_kind,
    (coalesce(v.error_kind, '') = 'OK'),
    v.owner_id,
    k.key_fingerprint,
    v.run_id::text,
    'BAKEOFF_RUN'::text,
    v.created_at
  from public.bakeoff_variants v
  left join public.user_ocr_keys k
    on k.owner_id = v.owner_id and k.provider = v.provider
  where v.status in ('DONE', 'FAILED')

  union all
  -- instruction rewrites (rewrite_jobs has no error_kind; normalize from status)
  select
    j.id,
    'rewrite'::text,
    j.owner_id,
    j.household_id,
    j.provider,
    j.model,
    coalesce(j.prompt_tokens, 0),
    coalesce(j.completion_tokens, 0),
    coalesce(j.cost_usd_micros, 0)::bigint,
    coalesce(j.latency_ms, 0),
    case when j.status = 'DONE' then 'OK' else 'OTHER' end,
    (j.status = 'DONE'),
    j.owner_id,
    k.key_fingerprint,
    j.recipe_id::text,
    'RECIPE'::text,
    j.created_at
  from public.rewrite_jobs j
  left join public.user_ocr_keys k
    on k.owner_id = j.owner_id and k.provider = j.provider
  where j.status in ('DONE', 'FAILED')

  union all
  -- one-shot ISBN scans + video/link imports + cover-image generations
  select
    m.id,
    m.feature,
    m.owner_id,
    m.household_id,
    m.provider,
    m.model,
    coalesce(m.prompt_tokens, 0),
    coalesce(m.completion_tokens, 0),
    coalesce(m.cost_usd_micros, 0)::bigint,
    coalesce(m.latency_ms, 0),
    m.error_kind,
    (coalesce(m.error_kind, 'OK') = 'OK'),
    coalesce(m.key_owner_id, m.owner_id),
    k.key_fingerprint,
    m.produced_ref,
    m.produced_kind,
    m.created_at
  from public.misc_llm_usage m
  left join public.user_ocr_keys k
    on k.owner_id = coalesce(m.key_owner_id, m.owner_id) and k.provider = m.provider

  union all
  -- recipe remix (remix_jobs has no error_kind; normalize from status)
  select
    r.id,
    'remix'::text,
    r.owner_id,
    r.household_id,
    r.provider,
    r.model,
    coalesce(r.prompt_tokens, 0),
    coalesce(r.completion_tokens, 0),
    coalesce(r.cost_usd_micros, 0)::bigint,
    coalesce(r.latency_ms, 0),
    case when r.status = 'DONE' then 'OK' else 'OTHER' end,
    (r.status = 'DONE'),
    r.owner_id,
    k.key_fingerprint,
    r.recipe_id::text,
    'RECIPE'::text,
    r.created_at
  from public.remix_jobs r
  left join public.user_ocr_keys k
    on k.owner_id = r.owner_id and k.provider = r.provider
  where r.status in ('DONE', 'FAILED');

grant select on public.llm_usage_report to authenticated;

analyze public.remix_jobs;
