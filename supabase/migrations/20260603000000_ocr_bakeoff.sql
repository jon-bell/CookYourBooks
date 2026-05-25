-- OCR bakeoff: server-side variant matrix + per-user default prefs.
--
-- The browser-side OCR path (localStorage api key + prompt) is going
-- away. Default model/prompt now lives here so the bulk-import worker
-- and the bakeoff page share one source of truth, and bakeoff results
-- can be "promoted" into the user's defaults with a single RPC.

-- ---------- ocr_test_fixtures: differentiate per-model ----------
--
-- Bakeoff variants run multiple models against the same image, and the
-- mock-mode fixture lookup needs to return *different* canned outputs
-- per variant. Add `model` to the lookup key. An empty string still
-- matches anything, so legacy fixtures (which don't set model) keep
-- working for the bulk-import path that runs a single model per batch.

alter table public.ocr_test_fixtures
  add column if not exists model text not null default '';

alter table public.ocr_test_fixtures drop constraint if exists ocr_test_fixtures_pkey;
alter table public.ocr_test_fixtures
  add primary key (item_storage_path, provider, model);

-- ---------- user_ocr_prefs ----------
--
-- One row per user. Drives the seed values on /import/new and the
-- prompt the worker uses when an import batch doesn't override it.

create table public.user_ocr_prefs (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'gemini'
    check (provider in ('gemini', 'openai-compatible')),
  model text not null default '',
  prompt text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.user_ocr_prefs enable row level security;

create policy "user_ocr_prefs_read_own" on public.user_ocr_prefs
  for select using (auth.uid() = owner_id);
create policy "user_ocr_prefs_upsert_own" on public.user_ocr_prefs
  for insert with check (auth.uid() = owner_id);
create policy "user_ocr_prefs_update_own" on public.user_ocr_prefs
  for update using (auth.uid() = owner_id);

-- ---------- import_batches.default_prompt ----------
--
-- The worker fell back to a hard-coded RECIPE_PROMPT before; now the
-- per-batch override comes from here. ImportNewPage seeds the column
-- with the user's pref but can edit per-batch. NULL means "use the
-- worker default" (preserved as a back-stop for older rows).

alter table public.import_batches
  add column if not exists default_prompt text;

-- ---------- bakeoff_runs ----------
--
-- One row per bakeoff invocation (one image races N variants). The
-- image lives in the existing `imports` bucket, scoped to the owner.

create table public.bakeoff_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  image_storage_path text not null,
  status text not null default 'OPEN'
    check (status in ('OPEN', 'CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bakeoff_runs enable row level security;

create policy "bakeoff_runs_read_own" on public.bakeoff_runs
  for select using (auth.uid() = owner_id);
create policy "bakeoff_runs_insert_own" on public.bakeoff_runs
  for insert with check (auth.uid() = owner_id);
create policy "bakeoff_runs_delete_own" on public.bakeoff_runs
  for delete using (auth.uid() = owner_id);

create index bakeoff_runs_owner_idx on public.bakeoff_runs(owner_id, created_at desc);

-- ---------- bakeoff_variants ----------
--
-- One row per (run × variant). Result columns are populated by the
-- worker when it finishes; `status` walks PENDING → CLAIMED → DONE/FAILED
-- through the same claim/lease pattern as `import_items`, so a wedged
-- worker is reclaimed automatically.

create table public.bakeoff_variants (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.bakeoff_runs(id) on delete cascade,
  -- Denormalized owner so RLS doesn't have to join on every read.
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- Position within the run. We can't order by created_at because all
  -- variants in a run land in the same transaction (now() is fixed) and
  -- UUIDv4 ids are unsortable.
  sort_index int not null default 0,
  name text not null default '',
  provider text not null
    check (provider in ('gemini', 'openai-compatible')),
  model text not null,
  prompt text not null,
  base_url text,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'CLAIMED', 'DONE', 'FAILED')),
  claim_token text,
  claim_expires_at timestamptz not null default 'epoch'::timestamptz,
  attempts int not null default 0,
  -- Result fields (NULL until the worker finishes).
  drafts jsonb,
  raw_text text,
  prompt_tokens int,
  completion_tokens int,
  cost_usd_micros int,
  latency_ms int,
  error_kind text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bakeoff_variants enable row level security;

create policy "bakeoff_variants_read_own" on public.bakeoff_variants
  for select using (auth.uid() = owner_id);
-- Inserts only go via the bakeoff_start RPC; deletes cascade from runs.

create index bakeoff_variants_claim_scan_idx
  on public.bakeoff_variants(status, claim_expires_at);
create index bakeoff_variants_run_idx
  on public.bakeoff_variants(run_id);

-- Realtime so the BakeoffPage can lean on the existing supabase
-- realtime subscription pattern instead of a poll loop (we still have a
-- poll fallback for the local-dev case where realtime is flaky).
alter publication supabase_realtime add table public.bakeoff_runs;
alter publication supabase_realtime add table public.bakeoff_variants;

-- ---------- bakeoff_start ----------
--
-- Caller passes the storage path of the uploaded image and a JSON
-- array of variants. Returns the run id so the page can subscribe.
-- The function inserts everything in one statement so a partial failure
-- can never leave a run with orphan variants.

create or replace function public.bakeoff_start(
  p_image_storage_path text,
  p_variants jsonb
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
  if p_variants is null or jsonb_array_length(p_variants) = 0 then
    raise exception 'At least one variant is required';
  end if;
  if jsonb_array_length(p_variants) > 8 then
    raise exception 'At most 8 variants per bakeoff';
  end if;

  insert into public.bakeoff_runs (owner_id, image_storage_path)
    values (caller, p_image_storage_path)
    returning id into run_id;

  -- ordinality gives a stable per-variant index without trusting
  -- created_at (every row in this txn shares now()).
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

revoke all on function public.bakeoff_start(text, jsonb) from public, anon;
grant execute on function public.bakeoff_start(text, jsonb) to authenticated;

-- ---------- bakeoff_claim_next ----------
--
-- Worker entrypoint. Mirrors import_claim_next so the worker can drain
-- bakeoff variants with the same claim/lease idiom.

create or replace function public.bakeoff_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 4
) returns setof public.bakeoff_variants
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bakeoff_variants
    set status = 'PENDING',
        claim_token = null
    where status = 'CLAIMED'
      and claim_expires_at < now();

  return query
    update public.bakeoff_variants
      set status = 'CLAIMED',
          claim_token = p_worker_id,
          claim_expires_at = now() + make_interval(secs => p_lease_seconds),
          attempts = attempts + 1,
          updated_at = now()
      where id in (
        select id from public.bakeoff_variants
          where status = 'PENDING'
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;

revoke all on function public.bakeoff_claim_next(text, int, int) from public, authenticated, anon;
grant execute on function public.bakeoff_claim_next(text, int, int) to service_role;

-- ---------- bakeoff_complete / bakeoff_fail ----------

create or replace function public.bakeoff_complete(
  p_variant_id uuid,
  p_claim_token text,
  p_result jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bakeoff_variants set
    status = 'DONE',
    drafts = p_result->'drafts',
    raw_text = p_result->>'raw_text',
    prompt_tokens = nullif((p_result->>'prompt_tokens')::int, 0),
    completion_tokens = nullif((p_result->>'completion_tokens')::int, 0),
    cost_usd_micros = (p_result->>'cost_usd_micros')::int,
    latency_ms = (p_result->>'latency_ms')::int,
    error_kind = 'OK',
    error_message = null,
    claim_token = null,
    updated_at = now()
    where id = p_variant_id and claim_token = p_claim_token;
  return found;
end;
$$;

revoke all on function public.bakeoff_complete(uuid, text, jsonb) from public, authenticated, anon;
grant execute on function public.bakeoff_complete(uuid, text, jsonb) to service_role;

create or replace function public.bakeoff_fail(
  p_variant_id uuid,
  p_claim_token text,
  p_error_kind text,
  p_error_message text,
  p_latency_ms int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bakeoff_variants set
    status = 'FAILED',
    error_kind = p_error_kind,
    error_message = p_error_message,
    latency_ms = p_latency_ms,
    claim_token = null,
    updated_at = now()
    where id = p_variant_id and claim_token = p_claim_token;
  return found;
end;
$$;

revoke all on function public.bakeoff_fail(uuid, text, text, text, int) from public, authenticated, anon;
grant execute on function public.bakeoff_fail(uuid, text, text, text, int) to service_role;

-- ---------- promote variant to default ----------
--
-- Copies a finished variant's (provider, model, prompt) into the
-- caller's user_ocr_prefs row.

create or replace function public.bakeoff_promote(
  p_variant_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  v public.bakeoff_variants%rowtype;
begin
  if caller is null then
    raise exception 'Not authenticated';
  end if;
  select * into v from public.bakeoff_variants
    where id = p_variant_id and owner_id = caller;
  if not found then
    raise exception 'Variant not found';
  end if;

  insert into public.user_ocr_prefs (owner_id, provider, model, prompt, updated_at)
    values (caller, v.provider, v.model, v.prompt, now())
    on conflict (owner_id) do update set
      provider = excluded.provider,
      model = excluded.model,
      prompt = excluded.prompt,
      updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.bakeoff_promote(uuid) from public, anon;
grant execute on function public.bakeoff_promote(uuid) to authenticated;

-- ---------- user_ocr_prefs setter (manual edit from Settings page) ----------

create or replace function public.user_ocr_prefs_set(
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
    raise exception 'Not authenticated';
  end if;
  insert into public.user_ocr_prefs (owner_id, provider, model, prompt, updated_at)
    values (caller, p_provider, p_model, p_prompt, now())
    on conflict (owner_id) do update set
      provider = excluded.provider,
      model = excluded.model,
      prompt = excluded.prompt,
      updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.user_ocr_prefs_set(text, text, text) from public, anon;
grant execute on function public.user_ocr_prefs_set(text, text, text) to authenticated;
