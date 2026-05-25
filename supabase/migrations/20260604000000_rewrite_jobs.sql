-- Instruction-rewriting pipeline.
--
-- The OCR pipeline lands a recipe whose instructions are often dense,
-- compound prose ("Heat a large pan, add the seeds, toast 2 minutes,
-- transfer to a mortar..."). That's fine on the recipe page but
-- terrible for hands-busy cooking — Cook Mode wants atomic single-
-- verb steps with optional timers extracted.
--
-- This migration adds:
--   - instructions.simplified_steps jsonb (per-step rewritten payload)
--   - rewrite_jobs (claim/lease queue, mirrors import_items)
--   - user_rewrite_prefs (default model + prompt, mirrors user_ocr_prefs)
--   - rewrite_test_fixtures (Playwright mock-mode lookup)
--   - bakeoff_runs.task_kind + input_recipe_id (REWRITE variant of bake-off)
--   - RPCs: rewrite_start / cancel / claim_next / complete / fail / kick,
--     user_rewrite_prefs_set, plus bakeoff_start signature extension and
--     bakeoff_promote routing.
--   - pg_cron `rewrite-worker-tick` (30s) that wakes the shared worker.
--
-- The shared `import-worker` Edge Function gets a third loop
-- (`runRewriteLoop`) so we don't pay for an extra cold start. BYOK
-- keys are reused: rewrites call `ocr_resolve_key` with the same vault
-- secret the user already configured for OCR.

-- ---------- instructions.simplified_steps ----------
--
-- jsonb so the worker can apply a result with a single
-- `update instructions set simplified_steps = ...`. NULL = "no rewrite
-- yet". An empty array `[]` is the explicit "rejected" marker so
-- the UI can hide the Improve button without re-running the LLM.

alter table public.instructions
  add column if not exists simplified_steps jsonb;

-- ---------- rewrite_jobs ----------
--
-- One row per (user-requested rewrite × recipe). Mirrors `import_items`
-- claim/lease so an expired-leased job is auto-reclaimed by the next
-- worker tick. We don't keep a job_attempts audit table for now — the
-- per-recipe payload is small and only one job is ever active per
-- recipe (a new request supersedes the prior PENDING/CLAIMED row).

create table public.rewrite_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'CLAIMED', 'DONE', 'FAILED')),
  provider text not null default 'gemini'
    check (provider in ('gemini', 'openai-compatible')),
  model text not null default '',
  prompt text not null default '',
  claim_token text,
  claim_expires_at timestamptz not null default 'epoch'::timestamptz,
  attempts int not null default 0,
  last_error text,
  -- Worker writes the full response payload here on completion; the
  -- `simplified_steps` columns on `instructions` are the authoritative
  -- copy that flows through realtime/sync to clients.
  result_json jsonb,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  cost_usd_micros bigint not null default 0,
  latency_ms int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index rewrite_jobs_owner_status_idx
  on public.rewrite_jobs(owner_id, status);
create index rewrite_jobs_claim_scan_idx
  on public.rewrite_jobs(status, claim_expires_at);
create index rewrite_jobs_recipe_idx
  on public.rewrite_jobs(recipe_id, created_at desc);

alter table public.rewrite_jobs enable row level security;

create policy "rewrite_jobs_own_all" on public.rewrite_jobs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create trigger rewrite_jobs_updated
  before update on public.rewrite_jobs
  for each row execute function public.touch_updated_at();

alter publication supabase_realtime add table public.rewrite_jobs;

-- ---------- user_rewrite_prefs ----------

create table public.user_rewrite_prefs (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'gemini'
    check (provider in ('gemini', 'openai-compatible')),
  model text not null default '',
  prompt text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.user_rewrite_prefs enable row level security;

create policy "user_rewrite_prefs_read_own" on public.user_rewrite_prefs
  for select using (auth.uid() = owner_id);
create policy "user_rewrite_prefs_upsert_own" on public.user_rewrite_prefs
  for insert with check (auth.uid() = owner_id);
create policy "user_rewrite_prefs_update_own" on public.user_rewrite_prefs
  for update using (auth.uid() = owner_id);

-- ---------- rewrite_test_fixtures ----------
--
-- Parallel to ocr_test_fixtures but keyed by recipe id (the rewrite
-- input isn't an image path). Tests seed a row before kicking the
-- worker; the worker probes (recipe_id, provider, model) first, then
-- widens to wildcards.

create table public.rewrite_test_fixtures (
  recipe_id text not null default '',
  provider text not null default '',
  model text not null default '',
  response_json jsonb not null default '{}'::jsonb,
  error_kind text
    check (error_kind in ('OK', 'RECITATION', 'RATE_LIMIT', 'AUTH', 'NETWORK', 'PARSE', 'TIMEOUT', 'OTHER')),
  latency_ms int not null default 0,
  created_at timestamptz not null default now(),
  primary key (recipe_id, provider, model)
);

alter table public.rewrite_test_fixtures enable row level security;

-- Authenticated reads only; tests use a service-role helper to seed
-- rows (same pattern as ocr_test_fixtures).
create policy "rewrite_test_fixtures_authenticated_read"
  on public.rewrite_test_fixtures
  for select to authenticated using (true);

-- ---------- bakeoff_runs extensions ----------
--
-- Bake-off is repurposed to compare rewrite variants too. A REWRITE run
-- doesn't have an image; it has an input recipe whose instructions are
-- shown to the model. image_storage_path becomes optional.

alter table public.bakeoff_runs
  add column if not exists task_kind text not null default 'OCR'
    check (task_kind in ('OCR', 'REWRITE'));
alter table public.bakeoff_runs
  add column if not exists input_recipe_id uuid
    references public.recipes(id) on delete set null;
alter table public.bakeoff_runs
  alter column image_storage_path drop not null;

-- ---------- rewrite_start ----------
--
-- Authenticated entry-point. Idempotent re-kick: any prior PENDING or
-- CLAIMED job for the same recipe is hard-deleted so a user clicking
-- Improve twice doesn't leave a zombie row in the queue.

create or replace function public.rewrite_start(
  p_recipe_id uuid,
  p_provider text,
  p_model text,
  p_prompt text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  recipe_owner uuid;
  job_id uuid;
begin
  if caller is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_provider not in ('gemini', 'openai-compatible') then
    raise exception 'Unknown provider %', p_provider using errcode = '22023';
  end if;
  if p_model is null or length(btrim(p_model)) = 0 then
    raise exception 'Model is required' using errcode = '22023';
  end if;
  if p_prompt is null or length(btrim(p_prompt)) = 0 then
    raise exception 'Prompt is required' using errcode = '22023';
  end if;

  -- Confirm caller owns the target recipe.
  select rc.owner_id into recipe_owner
    from public.recipes r
    join public.recipe_collections rc on rc.id = r.collection_id
    where r.id = p_recipe_id;
  if recipe_owner is null then
    raise exception 'Recipe not found' using errcode = '42501';
  end if;
  if recipe_owner <> caller then
    raise exception 'Recipe not owned by caller' using errcode = '42501';
  end if;

  -- Wipe any in-flight job for the same recipe so the worker won't
  -- race the new request.
  delete from public.rewrite_jobs
    where recipe_id = p_recipe_id
      and owner_id = caller
      and status in ('PENDING', 'CLAIMED');

  insert into public.rewrite_jobs (owner_id, recipe_id, provider, model, prompt)
    values (caller, p_recipe_id, p_provider, p_model, p_prompt)
    returning id into job_id;

  return job_id;
end;
$$;

revoke all on function public.rewrite_start(uuid, text, text, text) from public, anon;
grant execute on function public.rewrite_start(uuid, text, text, text) to authenticated;

-- ---------- rewrite_cancel ----------

create or replace function public.rewrite_cancel(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  job_owner uuid;
begin
  if caller is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  select owner_id into job_owner from public.rewrite_jobs where id = p_job_id;
  if job_owner is null then
    return false;
  end if;
  if job_owner <> caller then
    raise exception 'Not owner of job' using errcode = '42501';
  end if;
  update public.rewrite_jobs
    set status = 'FAILED',
        last_error = 'CANCELLED',
        claim_token = null
    where id = p_job_id and status in ('PENDING', 'CLAIMED');
  return found;
end;
$$;

revoke all on function public.rewrite_cancel(uuid) from public, anon;
grant execute on function public.rewrite_cancel(uuid) to authenticated;

-- ---------- rewrite_claim_next ----------

create or replace function public.rewrite_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 4
) returns setof public.rewrite_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rewrite_jobs
    set status = 'PENDING',
        claim_token = null
    where status = 'CLAIMED'
      and claim_expires_at < now();

  return query
    update public.rewrite_jobs
      set status = 'CLAIMED',
          claim_token = p_worker_id,
          claim_expires_at = now() + make_interval(secs => p_lease_seconds),
          attempts = attempts + 1,
          updated_at = now()
      where id in (
        select id from public.rewrite_jobs
          where status = 'PENDING'
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;

revoke all on function public.rewrite_claim_next(text, int, int) from public, authenticated, anon;
grant execute on function public.rewrite_claim_next(text, int, int) to service_role;

-- ---------- rewrite_complete ----------
--
-- Applies the LLM result *inside* the transaction that marks the job
-- DONE: each `{instructionId, simplifiedSteps[]}` entry updates the
-- matching instruction row. Touching the parent recipe's `updated_at`
-- forces the local-first sync engine to re-pull (the existing pull is
-- keyed off recipes.updated_at, which then cascades to instructions).

create or replace function public.rewrite_complete(
  p_job_id uuid,
  p_claim_token text,
  p_attempt jsonb,
  p_result jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  job_recipe uuid;
  job_owner uuid;
  entry jsonb;
begin
  select recipe_id, owner_id into job_recipe, job_owner
    from public.rewrite_jobs
    where id = p_job_id and claim_token = p_claim_token;
  if job_recipe is null then
    return false;
  end if;

  -- Apply each per-instruction payload. `simplifiedSteps` is forwarded
  -- as-is; the client mapping layer is tolerant of malformed entries.
  for entry in
    select * from jsonb_array_elements(coalesce(p_result->'rewritten', '[]'::jsonb))
  loop
    update public.instructions
      set simplified_steps = entry->'simplifiedSteps'
      where id = (entry->>'instructionId')::uuid
        and recipe_id = job_recipe;
  end loop;

  -- Bump parent recipe so the pull-side watermark moves past this point.
  update public.recipes
    set updated_at = now()
    where id = job_recipe;

  update public.rewrite_jobs set
    status = 'DONE',
    result_json = p_result,
    prompt_tokens = coalesce((p_attempt->>'prompt_tokens')::int, prompt_tokens),
    completion_tokens = coalesce((p_attempt->>'completion_tokens')::int, completion_tokens),
    cost_usd_micros = coalesce((p_attempt->>'cost_usd_micros')::bigint, cost_usd_micros),
    latency_ms = coalesce((p_attempt->>'latency_ms')::int, latency_ms),
    last_error = null,
    claim_token = null,
    updated_at = now()
    where id = p_job_id;

  return true;
end;
$$;

revoke all on function public.rewrite_complete(uuid, text, jsonb, jsonb) from public, authenticated, anon;
grant execute on function public.rewrite_complete(uuid, text, jsonb, jsonb) to service_role;

-- ---------- rewrite_fail ----------

create or replace function public.rewrite_fail(
  p_job_id uuid,
  p_claim_token text,
  p_attempt jsonb,
  p_next_state text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  job_owner uuid;
begin
  if p_next_state not in ('PENDING', 'FAILED') then
    raise exception 'Invalid next state %', p_next_state using errcode = '22023';
  end if;
  select owner_id into job_owner
    from public.rewrite_jobs
    where id = p_job_id and claim_token = p_claim_token;
  if job_owner is null then
    return false;
  end if;

  update public.rewrite_jobs set
    status = p_next_state,
    last_error = p_attempt->>'error_message',
    prompt_tokens = prompt_tokens + coalesce((p_attempt->>'prompt_tokens')::int, 0),
    completion_tokens = completion_tokens + coalesce((p_attempt->>'completion_tokens')::int, 0),
    cost_usd_micros = cost_usd_micros + coalesce((p_attempt->>'cost_usd_micros')::bigint, 0),
    latency_ms = coalesce((p_attempt->>'latency_ms')::int, latency_ms),
    claim_token = null
    where id = p_job_id;

  return true;
end;
$$;

revoke all on function public.rewrite_fail(uuid, text, jsonb, text) from public, authenticated, anon;
grant execute on function public.rewrite_fail(uuid, text, jsonb, text) to service_role;

-- ---------- rewrite_kick ----------
--
-- Mirrors ocr_kick. Uses the same vault secret so users only configure
-- one worker URL; the function URL on hosted Supabase is the same
-- regardless of which loop drains the work.

create or replace function public.rewrite_kick(p_recipe_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  cfg jsonb;
  url text;
  key text;
  caller uuid := auth.uid();
begin
  if p_recipe_id is not null and caller is not null then
    if not exists (
      select 1 from public.rewrite_jobs
        where recipe_id = p_recipe_id and owner_id = caller
    ) then
      -- Soft-skip: not having a job yet is fine (the cron tick will
      -- still drain anything pending), but kicking without one is a no-op.
      return;
    end if;
  end if;

  select decrypted_secret::jsonb into cfg
    from vault.decrypted_secrets
    where name = 'import_worker_config'
    limit 1;
  if cfg is null then
    raise exception 'OCR_WORKER_NOT_CONFIGURED: vault secret `import_worker_config` is not set. See CLAUDE.md "Setting up the OCR worker".';
  end if;

  url := cfg->>'function_url';
  key := cfg->>'service_role_key';
  if url is null or key is null then
    raise exception 'OCR_WORKER_NOT_CONFIGURED: vault secret `import_worker_config` is missing function_url or service_role_key.';
  end if;

  perform net.http_post(
    url := url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('rewrite', true)
  );
end;
$$;

revoke all on function public.rewrite_kick(uuid) from public;
grant execute on function public.rewrite_kick(uuid) to authenticated;

-- ---------- user_rewrite_prefs_set ----------

create or replace function public.user_rewrite_prefs_set(
  p_provider text,
  p_model text,
  p_prompt text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  insert into public.user_rewrite_prefs (owner_id, provider, model, prompt, updated_at)
    values (caller, p_provider, p_model, p_prompt, now())
    on conflict (owner_id) do update set
      provider = excluded.provider,
      model = excluded.model,
      prompt = excluded.prompt,
      updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.user_rewrite_prefs_set(text, text, text) from public, anon;
grant execute on function public.user_rewrite_prefs_set(text, text, text) to authenticated;

-- ---------- bakeoff_start (extended) ----------
--
-- Replaces the original bakeoff_start to take task_kind +
-- input_recipe_id and to make image_storage_path optional. Existing
-- callers continue to work because task_kind defaults to 'OCR'.

drop function if exists public.bakeoff_start(text, jsonb);

create or replace function public.bakeoff_start(
  p_image_storage_path text,
  p_variants jsonb,
  p_task_kind text default 'OCR',
  p_input_recipe_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  run_id uuid;
begin
  if caller is null then
    raise exception 'Not authenticated';
  end if;
  if p_task_kind not in ('OCR', 'REWRITE') then
    raise exception 'Unknown bakeoff task_kind %', p_task_kind using errcode = '22023';
  end if;
  if p_variants is null or jsonb_array_length(p_variants) = 0 then
    raise exception 'At least one variant is required';
  end if;
  if jsonb_array_length(p_variants) > 8 then
    raise exception 'At most 8 variants per bakeoff';
  end if;
  if p_task_kind = 'OCR' and (p_image_storage_path is null or length(btrim(p_image_storage_path)) = 0) then
    raise exception 'OCR bakeoff requires an image';
  end if;
  if p_task_kind = 'REWRITE' and p_input_recipe_id is null then
    raise exception 'REWRITE bakeoff requires an input recipe';
  end if;
  if p_task_kind = 'REWRITE' then
    -- Ownership check on the input recipe.
    if not exists (
      select 1 from public.recipes r
        join public.recipe_collections rc on rc.id = r.collection_id
        where r.id = p_input_recipe_id and rc.owner_id = caller
    ) then
      raise exception 'Input recipe not found or not owned by caller' using errcode = '42501';
    end if;
  end if;

  insert into public.bakeoff_runs (owner_id, image_storage_path, task_kind, input_recipe_id)
    values (caller,
            case when p_task_kind = 'OCR' then p_image_storage_path else null end,
            p_task_kind,
            p_input_recipe_id)
    returning id into run_id;

  insert into public.bakeoff_variants (
    run_id, owner_id, sort_index, name, provider, model, prompt, base_url
  )
  select
    run_id,
    caller,
    (ord - 1)::int,
    coalesce(elem->>'name', ''),
    coalesce(elem->>'provider', 'gemini'),
    coalesce(elem->>'model', ''),
    coalesce(elem->>'prompt', ''),
    elem->>'base_url'
  from jsonb_array_elements(p_variants) with ordinality as t(elem, ord);

  return run_id;
end;
$$;

revoke all on function public.bakeoff_start(text, jsonb, text, uuid) from public, anon;
grant execute on function public.bakeoff_start(text, jsonb, text, uuid) to authenticated;

-- ---------- bakeoff_promote (routes on task_kind) ----------

create or replace function public.bakeoff_promote(p_variant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  v public.bakeoff_variants%rowtype;
  task text;
begin
  if caller is null then
    raise exception 'Not authenticated';
  end if;
  select * into v from public.bakeoff_variants
    where id = p_variant_id and owner_id = caller;
  if not found then
    raise exception 'Variant not found';
  end if;
  select task_kind into task from public.bakeoff_runs where id = v.run_id;
  if task = 'REWRITE' then
    insert into public.user_rewrite_prefs (owner_id, provider, model, prompt, updated_at)
      values (caller, v.provider, v.model, v.prompt, now())
      on conflict (owner_id) do update set
        provider = excluded.provider,
        model = excluded.model,
        prompt = excluded.prompt,
        updated_at = excluded.updated_at;
  else
    insert into public.user_ocr_prefs (owner_id, provider, model, prompt, updated_at)
      values (caller, v.provider, v.model, v.prompt, now())
      on conflict (owner_id) do update set
        provider = excluded.provider,
        model = excluded.model,
        prompt = excluded.prompt,
        updated_at = excluded.updated_at;
  end if;
end;
$$;

revoke all on function public.bakeoff_promote(uuid) from public, anon;
grant execute on function public.bakeoff_promote(uuid) to authenticated;

-- ---------- pg_cron tick ----------

do $$ begin
  perform cron.schedule(
    'rewrite-worker-tick',
    '30 seconds',
    $cron$
      do $cronbody$
      begin
        perform public.rewrite_kick(null);
      exception when others then
        -- Swallow OCR_WORKER_NOT_CONFIGURED + transient pg_net errors so
        -- a fresh local install doesn't fill the log with red ink.
        null;
      end
      $cronbody$;
    $cron$
  );
exception when others then null;
end $$;
