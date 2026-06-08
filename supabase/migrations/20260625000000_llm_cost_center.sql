-- LLM Cost Center: a household-visible, read-only reporting surface over every
-- LLM query the user (or their household co-members) has run.
--
-- Cost is ALREADY captured per-query in three tables — import_item_attempts
-- (bulk OCR), bakeoff_variants (model bake-offs), rewrite_jobs (instruction
-- rewrites) — each with provider/model/prompt_tokens/completion_tokens/
-- cost_usd_micros/latency_ms. Two one-shot Gemini call sites recorded nothing
-- (cover/ISBN scans, link/video imports); this migration adds a small
-- misc_llm_usage table + a service-role record RPC for them.
--
-- The page reads ONLINE via a security_invoker view (llm_usage_report) +
-- a security_invoker rollup RPC (llm_usage_summary), exactly like the
-- household audit log + public_collections view — NOT through the local-first
-- SQLite cache. So there is no sync-engine change.
--
-- Household visibility reuses the claim-based RLS machinery (20260623000100 /
-- 20260623000200): each cost table gets a denormalized `household_id`
-- (maintained by the existing set_owned_row_household BEFORE trigger +
-- refresh_household_denorm) and a consolidated `_read` policy whose household
-- branch is a pure JWT-claim-vs-column compare. Visibility therefore follows
-- the owner's library-sharing flag automatically (household_id is NULL when the
-- owner isn't sharing).

-- ============================================================
-- 1. columns: denormalized household_id on the three cost tables,
--    plus key_owner_id on import_item_attempts (see §1b rationale)
-- ============================================================
alter table public.import_item_attempts add column if not exists household_id uuid;
alter table public.bakeoff_variants      add column if not exists household_id uuid;
alter table public.rewrite_jobs           add column if not exists household_id uuid;

-- WHY key_owner_id on the attempt row (not a join up to import_batches):
-- the "whose key paid" pointer lives on import_batches.key_owner_id (NULL =>
-- the batch owner used their own key). The llm_usage_report view runs with
-- security_invoker, so a co-member viewing another member's attempt cannot
-- read the owner-only import_items/import_batches rows — a join up to the
-- batch would filter the attempt out and OCR usage would vanish from the
-- household view. Carrying key_owner_id ON the attempt keeps the OCR arm
-- self-contained to a table the viewer can already read.
alter table public.import_item_attempts add column if not exists key_owner_id uuid;

-- ============================================================
-- 2. new table: misc_llm_usage (one row per ISBN-scan / video-import call)
-- ============================================================
create table if not exists public.misc_llm_usage (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  household_id uuid,                       -- denormalized, trigger-maintained, no FK (matches 20260623000100)
  key_owner_id uuid,                       -- whose key paid (NULL => owner's own key)
  feature text not null check (feature in ('isbn', 'video')),
  provider text not null default '',
  model text not null default '',
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  cost_usd_micros bigint not null default 0,
  latency_ms int not null default 0,
  error_kind text,
  produced_ref text,                       -- the ISBN string / source URL (text, non-uuid ref)
  produced_kind text,                      -- 'ISBN' | 'VIDEO_URL'
  created_at timestamptz not null default now()
);

alter table public.misc_llm_usage enable row level security;

create policy "misc_llm_usage_read" on public.misc_llm_usage
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );
-- No write policy: rows are written only by misc_llm_usage_record (service role).

create index if not exists misc_llm_usage_owner_created_idx
  on public.misc_llm_usage(owner_id, created_at);
create index if not exists misc_llm_usage_household_idx
  on public.misc_llm_usage(household_id) where household_id is not null;

drop trigger if exists misc_llm_usage_set_household on public.misc_llm_usage;
create trigger misc_llm_usage_set_household
  before insert or update of owner_id on public.misc_llm_usage
  for each row execute function public.set_owned_row_household();

-- ============================================================
-- 3. backfill (set-based; the household_id-only updates below don't touch
--    owner_id, so the set_owned_row_household trigger never fires for them)
-- ============================================================
-- household_id = the owner's active *sharing* household (NULL otherwise).
update public.import_item_attempts t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;
update public.bakeoff_variants t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;
update public.rewrite_jobs t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;

-- key_owner_id on historical attempts, from the parent batch (NULL => self).
update public.import_item_attempts a
   set key_owner_id = b.key_owner_id
  from public.import_items it
  join public.import_batches b on b.id = it.batch_id
 where it.id = a.item_id
   and a.key_owner_id is distinct from b.key_owner_id;

-- ============================================================
-- 4. write-time household_id triggers (reuse set_owned_row_household)
-- ============================================================
drop trigger if exists import_item_attempts_set_household on public.import_item_attempts;
create trigger import_item_attempts_set_household
  before insert or update of owner_id on public.import_item_attempts
  for each row execute function public.set_owned_row_household();

drop trigger if exists bakeoff_variants_set_household on public.bakeoff_variants;
create trigger bakeoff_variants_set_household
  before insert or update of owner_id on public.bakeoff_variants
  for each row execute function public.set_owned_row_household();

drop trigger if exists rewrite_jobs_set_household on public.rewrite_jobs;
create trigger rewrite_jobs_set_household
  before insert or update of owner_id on public.rewrite_jobs
  for each row execute function public.set_owned_row_household();

-- ============================================================
-- 5. extend refresh_household_denorm to re-stamp the four cost tables on a
--    sharing transition (full re-emit of 20260623000100's body + 4 lines).
--    Does NOT bump any updated_at (consistent with the original design note).
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
  -- LLM Cost Center cost tables:
  update public.import_item_attempts         set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.bakeoff_variants             set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.rewrite_jobs                 set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.misc_llm_usage               set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
end;
$$;
revoke all on function public.refresh_household_denorm(uuid) from public, anon, authenticated;

-- ============================================================
-- 6. redefine import_complete / import_fail to stamp key_owner_id on the
--    attempt row (from the parent batch). Bodies are otherwise the current
--    versions (import_complete: 20260522000000; import_fail: 20260622000100).
-- ============================================================
create or replace function public.import_complete(
  p_item_id uuid,
  p_claim_token text,
  p_attempt jsonb,
  p_parsed_drafts jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  next_attempt int;
  item_owner uuid;
  v_key_owner uuid;
begin
  select it.owner_id, b.key_owner_id
    into item_owner, v_key_owner
    from public.import_items it
    join public.import_batches b on b.id = it.batch_id
    where it.id = p_item_id and it.claim_token = p_claim_token;
  if item_owner is null then
    return false;
  end if;

  select coalesce(max(attempt_no), 0) + 1
    into next_attempt
    from public.import_item_attempts
    where item_id = p_item_id;

  insert into public.import_item_attempts (
    item_id, owner_id, key_owner_id, attempt_no,
    provider, model, raw_response_path,
    error_kind, error_message,
    prompt_tokens, completion_tokens, cost_usd_micros, latency_ms,
    started_at, finished_at
  ) values (
    p_item_id, item_owner, v_key_owner, next_attempt,
    coalesce(p_attempt->>'provider', ''),
    coalesce(p_attempt->>'model', ''),
    p_attempt->>'raw_response_path',
    coalesce(p_attempt->>'error_kind', 'OK'),
    p_attempt->>'error_message',
    coalesce((p_attempt->>'prompt_tokens')::int, 0),
    coalesce((p_attempt->>'completion_tokens')::int, 0),
    coalesce((p_attempt->>'cost_usd_micros')::bigint, 0),
    coalesce((p_attempt->>'latency_ms')::int, 0),
    coalesce((p_attempt->>'started_at')::timestamptz, now()),
    coalesce((p_attempt->>'finished_at')::timestamptz, now())
  );

  update public.import_items
    set status = 'OCR_DONE',
        parsed_drafts_json = p_parsed_drafts,
        model_used = coalesce(p_attempt->>'model', model_used),
        prompt_tokens = prompt_tokens + coalesce((p_attempt->>'prompt_tokens')::int, 0),
        completion_tokens = completion_tokens + coalesce((p_attempt->>'completion_tokens')::int, 0),
        cost_usd_micros = cost_usd_micros + coalesce((p_attempt->>'cost_usd_micros')::bigint, 0),
        attempts = attempts + 1,
        claim_token = null,
        last_error = null,
        needs_fallback = false
    where id = p_item_id;

  return true;
end;
$$;

revoke all on function public.import_complete(uuid, text, jsonb, jsonb) from public, authenticated, anon;
grant execute on function public.import_complete(uuid, text, jsonb, jsonb) to service_role;

create or replace function public.import_fail(
  p_item_id uuid,
  p_claim_token text,
  p_attempt jsonb,
  p_next_state text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  next_attempt int;
  item_owner uuid;
  v_key_owner uuid;
begin
  if p_next_state not in ('PENDING', 'NEEDS_FALLBACK', 'OCR_FAILED') then
    raise exception 'Invalid next state %', p_next_state using errcode = '22023';
  end if;

  select it.owner_id, b.key_owner_id
    into item_owner, v_key_owner
    from public.import_items it
    join public.import_batches b on b.id = it.batch_id
    where it.id = p_item_id and it.claim_token = p_claim_token;
  if item_owner is null then
    return false;
  end if;

  select coalesce(max(attempt_no), 0) + 1
    into next_attempt
    from public.import_item_attempts
    where item_id = p_item_id;

  insert into public.import_item_attempts (
    item_id, owner_id, key_owner_id, attempt_no,
    provider, model, raw_response_path,
    error_kind, error_message,
    prompt_tokens, completion_tokens, cost_usd_micros, latency_ms,
    started_at, finished_at
  ) values (
    p_item_id, item_owner, v_key_owner, next_attempt,
    coalesce(p_attempt->>'provider', ''),
    coalesce(p_attempt->>'model', ''),
    p_attempt->>'raw_response_path',
    coalesce(p_attempt->>'error_kind', 'OTHER'),
    p_attempt->>'error_message',
    coalesce((p_attempt->>'prompt_tokens')::int, 0),
    coalesce((p_attempt->>'completion_tokens')::int, 0),
    coalesce((p_attempt->>'cost_usd_micros')::bigint, 0),
    coalesce((p_attempt->>'latency_ms')::int, 0),
    coalesce((p_attempt->>'started_at')::timestamptz, now()),
    coalesce((p_attempt->>'finished_at')::timestamptz, now())
  );

  update public.import_items
    set status = p_next_state,
        attempts = attempts + 1,
        -- Accrue usage even on failed attempts (they still cost money).
        prompt_tokens = prompt_tokens + coalesce((p_attempt->>'prompt_tokens')::int, 0),
        completion_tokens = completion_tokens + coalesce((p_attempt->>'completion_tokens')::int, 0),
        cost_usd_micros = cost_usd_micros + coalesce((p_attempt->>'cost_usd_micros')::bigint, 0),
        last_error = p_attempt->>'error_message',
        claim_token = null,
        needs_fallback = case
          when p_next_state = 'NEEDS_FALLBACK' then true
          when p_next_state = 'OCR_FAILED' then false
          else needs_fallback
        end
    where id = p_item_id;

  return true;
end;
$$;

revoke all on function public.import_fail(uuid, text, jsonb, text) from public, authenticated, anon;
grant execute on function public.import_fail(uuid, text, jsonb, text) to service_role;

-- ============================================================
-- 7. RLS: consolidate each cost table's owner-only SELECT into a claim-based
--    `_read` (own OR household), preserving write semantics. `own` is OR'd
--    FIRST and the household branch keeps `owner_id <> (select auth.uid())`
--    as its first AND-term (Realtime invariant — all three are in
--    supabase_realtime). Writes happen under service_role via the worker RPCs;
--    the owner-only write policies preserve the original FOR ALL footprint.
-- ============================================================
-- import_item_attempts (was import_item_attempts_own_all, FOR ALL)
drop policy if exists "import_item_attempts_own_all" on public.import_item_attempts;
create policy "import_item_attempts_read" on public.import_item_attempts
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );
create policy "import_item_attempts_insert_own" on public.import_item_attempts
  for insert with check (owner_id = (select auth.uid()));
create policy "import_item_attempts_update_own" on public.import_item_attempts
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "import_item_attempts_delete_own" on public.import_item_attempts
  for delete using (owner_id = (select auth.uid()));

-- bakeoff_variants (was bakeoff_variants_read_own, SELECT-only — just widen)
drop policy if exists "bakeoff_variants_read_own" on public.bakeoff_variants;
create policy "bakeoff_variants_read" on public.bakeoff_variants
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );

-- rewrite_jobs (was rewrite_jobs_own_all, FOR ALL)
drop policy if exists "rewrite_jobs_own_all" on public.rewrite_jobs;
create policy "rewrite_jobs_read" on public.rewrite_jobs
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );
create policy "rewrite_jobs_insert_own" on public.rewrite_jobs
  for insert with check (owner_id = (select auth.uid()));
create policy "rewrite_jobs_update_own" on public.rewrite_jobs
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "rewrite_jobs_delete_own" on public.rewrite_jobs
  for delete using (owner_id = (select auth.uid()));

-- ============================================================
-- 8. household partial indexes (mirror 20260623000100 §5)
-- ============================================================
create index if not exists import_item_attempts_household_idx
  on public.import_item_attempts(household_id) where household_id is not null;
create index if not exists bakeoff_variants_household_idx
  on public.bakeoff_variants(household_id) where household_id is not null;
create index if not exists rewrite_jobs_household_idx
  on public.rewrite_jobs(household_id) where household_id is not null;

-- ============================================================
-- 9. the reporting view (security_invoker: base-table RLS does own+household
--    filtering as the caller). Each LEFT JOIN to user_ocr_keys resolves the
--    non-secret key_fingerprint for whoever's key paid — under invoker rights
--    the key owner sees the fingerprint on every query that used their key
--    (incl. co-members' borrowed-key imports); other viewers see the row with
--    a NULL fingerprint. vault_secret_id is column-revoked and never selected.
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
  -- one-shot ISBN scans + video/link imports
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
    on k.owner_id = coalesce(m.key_owner_id, m.owner_id) and k.provider = m.provider;

grant select on public.llm_usage_report to authenticated;

-- ============================================================
-- 10. misc_llm_usage_record: the service-role write path for ISBN/video.
--     Computes cost_usd_micros server-side from model_pricing when the caller
--     doesn't supply one (ISBN/video have no client-side pricing card). This
--     is the single sanctioned server-side read of model_pricing for these
--     features — NO client RLS is added to model_pricing.
-- ============================================================
create or replace function public.misc_llm_usage_record(p_event jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := nullif(p_event->>'owner_id', '')::uuid;
  v_provider text := coalesce(p_event->>'provider', '');
  v_model text := coalesce(p_event->>'model', '');
  v_prompt int := coalesce((p_event->>'prompt_tokens')::int, 0);
  v_completion int := coalesce((p_event->>'completion_tokens')::int, 0);
  v_cost bigint;
  v_rate public.model_pricing%rowtype;
  v_id uuid;
begin
  if v_owner is null then
    raise exception 'owner_id required' using errcode = '22023';
  end if;
  if coalesce(p_event->>'feature', '') not in ('isbn', 'video') then
    raise exception 'feature must be isbn|video' using errcode = '22023';
  end if;

  if p_event ? 'cost_usd_micros' then
    v_cost := coalesce((p_event->>'cost_usd_micros')::bigint, 0);
  else
    select * into v_rate from public.model_pricing
      where provider = v_provider and model = v_model;
    if found then
      -- cost_usd_micros = round(prompt*input_per_mtok + completion*output_per_mtok)
      -- (mirrors supabase/functions/import-worker/pricing.ts).
      v_cost := round(
        v_prompt * v_rate.input_usd_per_mtok
        + v_completion * v_rate.output_usd_per_mtok
      )::bigint;
    else
      v_cost := 0;  -- unknown model: keep the token record, don't fabricate a cost
    end if;
  end if;

  insert into public.misc_llm_usage (
    owner_id, key_owner_id, feature, provider, model,
    prompt_tokens, completion_tokens, cost_usd_micros, latency_ms,
    error_kind, produced_ref, produced_kind
  ) values (
    v_owner,
    nullif(p_event->>'key_owner_id', '')::uuid,
    p_event->>'feature', v_provider, v_model,
    v_prompt, v_completion, v_cost,
    coalesce((p_event->>'latency_ms')::int, 0),
    nullif(p_event->>'error_kind', ''),
    nullif(p_event->>'produced_ref', ''),
    nullif(p_event->>'produced_kind', '')
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.misc_llm_usage_record(jsonb) from public, anon, authenticated;
grant execute on function public.misc_llm_usage_record(jsonb) to service_role;

-- ============================================================
-- 11. rollup RPC (security INVOKER — reads the view under the caller's RLS,
--     so it cannot leak another household's costs even as an RPC).
-- ============================================================
create or replace function public.llm_usage_summary(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_group_by text default 'model'         -- 'model'|'provider'|'member'|'feature'|'day'
) returns table (
  bucket text,
  member_id uuid,
  queries bigint,
  prompt_tokens bigint,
  completion_tokens bigint,
  cost_usd_micros bigint,
  failures bigint,
  avg_latency_ms numeric
)
language sql stable security invoker set search_path = public as $$
  select
    case p_group_by
      when 'provider' then r.provider
      when 'member'   then r.key_owner_id::text
      when 'feature'  then r.feature
      when 'day'      then to_char(date_trunc('day', r.created_at), 'YYYY-MM-DD')
      else r.model
    end as bucket,
    case when p_group_by = 'member' then r.key_owner_id end as member_id,
    count(*)::bigint as queries,
    sum(r.prompt_tokens)::bigint as prompt_tokens,
    sum(r.completion_tokens)::bigint as completion_tokens,
    sum(r.cost_usd_micros)::bigint as cost_usd_micros,
    sum((not r.succeeded)::int)::bigint as failures,
    avg(r.latency_ms)::numeric as avg_latency_ms
  from public.llm_usage_report r
  where (p_from is null or r.created_at >= p_from)
    and (p_to is null or r.created_at < p_to)
  group by 1, 2;
$$;
grant execute on function public.llm_usage_summary(timestamptz, timestamptz, text) to authenticated;

analyze public.import_item_attempts;
analyze public.bakeoff_variants;
analyze public.rewrite_jobs;
analyze public.misc_llm_usage;
