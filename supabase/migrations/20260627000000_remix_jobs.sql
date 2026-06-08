-- Recipe Remix pipeline.
--
-- "Remix" takes an existing recipe + a freeform user request ("make it a
-- sheet-pan dinner", "swap the beef for lamb", "make it vegetarian") and
-- runs it through an LLM to produce a *new* recipe. The original is never
-- modified — the worker emits a recipe draft, the client promotes it into
-- a brand-new recipe (with parent_recipe_id pointing back at the source).
--
-- This is a near-clone of the instruction-rewrite pipeline
-- (20260604000001_rewrite_jobs.sql) with four deliberate divergences:
--   1. remix_complete only STORES the produced draft (result_json) — it
--      does NOT apply anything onto existing rows and does NOT bump the
--      source recipe's updated_at. The client owns promotion.
--   2. The job carries the working recipe to transform (input_recipe_json),
--      supplied by the client. Turn 1 sends the original recipe; each chat
--      follow-up sends the previous turn's draft. So the worker needs no
--      server-side recipe load.
--   3. remix_start gates on READ access, not ownership — you may remix any
--      recipe you can see (incl. a household co-member's shared recipe).
--      The new recipe is created client-side into one of YOUR collections.
--   4. The LLM returns a full recipe in the OCR import schema, parsed by the
--      worker's parseLlmJson into a ParsedRecipeDraft.
--
-- The shared `import-worker` Edge Function gains a `runRemixLoop`. BYOK keys
-- are reused: remix calls ocr_resolve_effective_key with the same vault
-- secret the user already configured for OCR, and remix_kick reuses the same
-- import_worker_config secret + OCR_WORKER_NOT_CONFIGURED error class.

-- ---------- remix_jobs ----------
--
-- One in-flight row per (recipe × owner); DONE rows persist for the Cost
-- Center. Mirrors rewrite_jobs' claim/lease so an expired lease is auto-
-- reclaimed by the next worker tick.

create table public.remix_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'CLAIMED', 'DONE', 'FAILED')),
  provider text not null default 'gemini'
    check (provider in ('gemini', 'openai-compatible')),
  model text not null default '',
  -- System-prompt override (from user_remix_prefs); worker falls back to the
  -- built-in REMIX_PROMPT when blank.
  prompt text not null default '',
  -- The user's freeform remix request for this turn.
  instruction text not null default '',
  -- The working recipe to transform, supplied by the client (the source
  -- recipe on turn 1, the prior turn's draft on follow-ups). Not mirrored to
  -- the local cache — the client already has it.
  input_recipe_json jsonb,
  claim_token text,
  claim_expires_at timestamptz not null default 'epoch'::timestamptz,
  attempts int not null default 0,
  last_error text,
  -- Worker writes the produced ParsedRecipeDraft here on completion. The
  -- client reads it back (via the local mirror) and promotes it into a new
  -- recipe through the normal local-first save path.
  result_json jsonb,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  cost_usd_micros bigint not null default 0,
  latency_ms int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index remix_jobs_owner_status_idx
  on public.remix_jobs(owner_id, status);
create index remix_jobs_claim_scan_idx
  on public.remix_jobs(status, claim_expires_at);
create index remix_jobs_recipe_idx
  on public.remix_jobs(recipe_id, created_at desc);

alter table public.remix_jobs enable row level security;

-- Owner-only baseline. Superseded by the consolidated read/insert/update/
-- delete policies in 20260628000000_remix_cost_center.sql (which add the
-- household claim-vs-column read branch) — same lifecycle rewrite_jobs had.
create policy "remix_jobs_own_all" on public.remix_jobs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create trigger remix_jobs_updated
  before update on public.remix_jobs
  for each row execute function public.touch_updated_at();

alter publication supabase_realtime add table public.remix_jobs;

-- ---------- user_remix_prefs ----------

create table public.user_remix_prefs (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'gemini'
    check (provider in ('gemini', 'openai-compatible')),
  model text not null default '',
  prompt text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.user_remix_prefs enable row level security;

create policy "user_remix_prefs_read_own" on public.user_remix_prefs
  for select using (auth.uid() = owner_id);
create policy "user_remix_prefs_upsert_own" on public.user_remix_prefs
  for insert with check (auth.uid() = owner_id);
create policy "user_remix_prefs_update_own" on public.user_remix_prefs
  for update using (auth.uid() = owner_id);

-- ---------- remix_test_fixtures ----------
--
-- Parallel to rewrite_test_fixtures: keyed by recipe id (the remix input
-- isn't an image path). Tests seed a row before kicking the worker; the
-- worker probes (recipe_id, provider, model) first, then widens to wildcards.

create table public.remix_test_fixtures (
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

alter table public.remix_test_fixtures enable row level security;

create policy "remix_test_fixtures_authenticated_read"
  on public.remix_test_fixtures
  for select to authenticated using (true);

-- ---------- remix_start ----------
--
-- Authenticated entry-point. Idempotent re-kick: any prior PENDING/CLAIMED
-- job for the same (recipe, owner) is hard-deleted so a double-click — or a
-- chat follow-up — doesn't leave a zombie row in the queue.
--
-- OWNERSHIP: unlike rewrite_start (which mutates the recipe in place and so
-- requires recipe_owner = caller), remix never touches the source recipe.
-- It only requires the caller to be able to READ it — mirroring the
-- recipes_read policy's claim-vs-column compare so household co-members can
-- remix a shared recipe. The new recipe is created client-side into one of
-- the caller's OWN collections (enforced by recipes' write policy).

create or replace function public.remix_start(
  p_recipe_id uuid,
  p_provider text,
  p_model text,
  p_prompt text,
  p_instruction text,
  p_input_recipe_json jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
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
  if p_instruction is null or length(btrim(p_instruction)) = 0 then
    raise exception 'A remix instruction is required' using errcode = '22023';
  end if;

  -- Read gate (NOT ownership): caller owns the recipe, or it's shared into
  -- the caller's active household. Same predicate as the recipes_read RLS
  -- policy; safe under security definer because auth.uid()/auth.jwt() read
  -- the caller's request JWT, not the function owner.
  if not exists (
    select 1 from public.recipes r
    where r.id = p_recipe_id
      and ( r.owner_id = caller
            or ( r.owner_id <> caller
                 and r.household_id = (auth.jwt() ->> 'household_id')::uuid ) )
  ) then
    raise exception 'Recipe not found or not readable' using errcode = '42501';
  end if;

  -- Wipe any in-flight job for the same (recipe, owner) so the worker won't
  -- race the new request.
  delete from public.remix_jobs
    where recipe_id = p_recipe_id
      and owner_id = caller
      and status in ('PENDING', 'CLAIMED');

  insert into public.remix_jobs (
    owner_id, recipe_id, provider, model, prompt, instruction, input_recipe_json
  )
    values (caller, p_recipe_id, p_provider, p_model,
            coalesce(p_prompt, ''), p_instruction, p_input_recipe_json)
    returning id into job_id;

  return job_id;
end;
$$;

revoke all on function public.remix_start(uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function public.remix_start(uuid, text, text, text, text, jsonb) to authenticated;

-- ---------- remix_cancel ----------

create or replace function public.remix_cancel(p_job_id uuid)
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
  select owner_id into job_owner from public.remix_jobs where id = p_job_id;
  if job_owner is null then
    return false;
  end if;
  if job_owner <> caller then
    raise exception 'Not owner of job' using errcode = '42501';
  end if;
  update public.remix_jobs
    set status = 'FAILED',
        last_error = 'CANCELLED',
        claim_token = null
    where id = p_job_id and status in ('PENDING', 'CLAIMED');
  return found;
end;
$$;

revoke all on function public.remix_cancel(uuid) from public, anon;
grant execute on function public.remix_cancel(uuid) to authenticated;

-- ---------- remix_claim_next ----------

create or replace function public.remix_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 4
) returns setof public.remix_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.remix_jobs
    set status = 'PENDING',
        claim_token = null
    where status = 'CLAIMED'
      and claim_expires_at < now();

  return query
    update public.remix_jobs
      set status = 'CLAIMED',
          claim_token = p_worker_id,
          claim_expires_at = now() + make_interval(secs => p_lease_seconds),
          attempts = attempts + 1,
          updated_at = now()
      where id in (
        select id from public.remix_jobs
          where status = 'PENDING'
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;

revoke all on function public.remix_claim_next(text, int, int) from public, authenticated, anon;
grant execute on function public.remix_claim_next(text, int, int) to service_role;

-- ---------- remix_complete ----------
--
-- DIVERGES from rewrite_complete: it does NOT apply the result onto any
-- existing row and does NOT bump the source recipe's updated_at. It only
-- records the produced draft + cost and marks the job DONE; the client
-- reads result_json back (via the local mirror) and promotes it into a new
-- recipe through the normal save path.

create or replace function public.remix_complete(
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
  job_owner uuid;
begin
  select owner_id into job_owner
    from public.remix_jobs
    where id = p_job_id and claim_token = p_claim_token;
  if job_owner is null then
    return false;
  end if;

  update public.remix_jobs set
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

revoke all on function public.remix_complete(uuid, text, jsonb, jsonb) from public, authenticated, anon;
grant execute on function public.remix_complete(uuid, text, jsonb, jsonb) to service_role;

-- ---------- remix_fail ----------

create or replace function public.remix_fail(
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
    from public.remix_jobs
    where id = p_job_id and claim_token = p_claim_token;
  if job_owner is null then
    return false;
  end if;

  update public.remix_jobs set
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

revoke all on function public.remix_fail(uuid, text, jsonb, text) from public, authenticated, anon;
grant execute on function public.remix_fail(uuid, text, jsonb, text) to service_role;

-- ---------- remix_kick ----------
--
-- Mirrors rewrite_kick / ocr_kick. Reuses the same import_worker_config
-- vault secret and the same OCR_WORKER_NOT_CONFIGURED error class, so the
-- frontend's existing OcrWorkerNotConfiguredError handling already covers
-- the unconfigured case.

create or replace function public.remix_kick(p_recipe_id uuid default null)
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
      select 1 from public.remix_jobs
        where recipe_id = p_recipe_id and owner_id = caller
    ) then
      -- Soft-skip: kicking without a queued job is a no-op (the cron tick
      -- still drains anything pending).
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
    body := jsonb_build_object('remix', true)
  );
end;
$$;

revoke all on function public.remix_kick(uuid) from public;
grant execute on function public.remix_kick(uuid) to authenticated;

-- ---------- user_remix_prefs_set ----------

create or replace function public.user_remix_prefs_set(
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
  insert into public.user_remix_prefs (owner_id, provider, model, prompt, updated_at)
    values (caller, p_provider, p_model, p_prompt, now())
    on conflict (owner_id) do update set
      provider = excluded.provider,
      model = excluded.model,
      prompt = excluded.prompt,
      updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.user_remix_prefs_set(text, text, text) from public, anon;
grant execute on function public.user_remix_prefs_set(text, text, text) to authenticated;

-- ---------- pg_cron tick ----------

do $$ begin
  perform cron.schedule(
    'remix-worker-tick',
    '30 seconds',
    $cron$
      do $cronbody$
      begin
        perform public.remix_kick(null);
      exception when others then
        -- Swallow OCR_WORKER_NOT_CONFIGURED + transient pg_net errors so a
        -- fresh local install doesn't fill the log with red ink.
        null;
      end
      $cronbody$;
    $cron$
  );
exception when others then null;
end $$;
