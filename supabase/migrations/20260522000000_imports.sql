-- Bulk image upload + async OCR pipeline.
--
-- A user uploads dozens-to-hundreds of cookbook pages (images or pages
-- split from a PDF) into the `imports` storage bucket. A Supabase Edge
-- Function worker drains the queue, calls a multimodal LLM with each
-- page, and writes the resulting `ParsedRecipeDraft[]` back onto the
-- item. The user reviews drafts in a dedicated UI and promotes them
-- into the regular recipes tables.
--
-- Provider API keys never live in the browser — they're written
-- straight into Vault by the `ocr_key_set` RPC and read by the Edge
-- Function under the service role.

-- ---------- Extensions ----------

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net;
-- pg_cron may be unavailable on some local installs. The
-- `ocr_kick` cron schedule below is wrapped so reset still succeeds.
do $$ begin
  create extension if not exists pg_cron;
exception when others then null;
end $$;

-- ---------- import_batches ----------

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default '',
  source_kind text not null default 'IMAGES'
    check (source_kind in ('IMAGES', 'PDF')),
  target_collection_id uuid references public.recipe_collections(id) on delete set null,
  default_model text not null default '',
  default_provider text not null default 'gemini'
    check (default_provider in ('gemini', 'openai-compatible')),
  fallback_model text,
  fallback_provider text
    check (fallback_provider in ('gemini', 'openai-compatible')),
  recitation_policy text not null default 'ASK'
    check (recitation_policy in ('ASK', 'FALLBACK', 'FAIL')),
  status text not null default 'OPEN'
    check (status in ('OPEN', 'ARCHIVED')),
  total_items int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index import_batches_owner_idx on public.import_batches(owner_id, created_at desc);

alter table public.import_batches enable row level security;

create policy "import_batches_own_all" on public.import_batches
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create trigger import_batches_updated
  before update on public.import_batches
  for each row execute function public.touch_updated_at();

-- ---------- import_items ----------

create table public.import_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  page_index int not null default 0,
  storage_path text not null default '',
  thumb_path text,
  source_pdf_path text,
  source_pdf_page int,
  assigned_collection_id uuid references public.recipe_collections(id) on delete set null,
  assigned_page_number int,
  is_toc boolean not null default false,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'CLAIMED', 'OCR_DONE', 'NEEDS_FALLBACK', 'OCR_FAILED', 'REVIEWED', 'DISCARDED')),
  claim_token text,
  claim_expires_at timestamptz not null default 'epoch'::timestamptz,
  attempts int not null default 0,
  last_error text,
  parsed_drafts_json jsonb,
  model_used text,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  cost_usd_micros bigint not null default 0,
  created_recipe_ids uuid[] not null default '{}',
  needs_fallback boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index import_items_batch_idx on public.import_items(batch_id, page_index);
create index import_items_owner_status_idx on public.import_items(owner_id, status);
create index import_items_claim_scan_idx on public.import_items(status, claim_expires_at);

alter table public.import_items enable row level security;

create policy "import_items_own_all" on public.import_items
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create trigger import_items_updated
  before update on public.import_items
  for each row execute function public.touch_updated_at();

-- ---------- import_item_attempts ----------

create table public.import_item_attempts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.import_items(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  attempt_no int not null default 1,
  provider text not null default '',
  model text not null default '',
  raw_response_path text,
  error_kind text
    check (error_kind in ('OK', 'RECITATION', 'RATE_LIMIT', 'AUTH', 'NETWORK', 'PARSE', 'TIMEOUT', 'OTHER')),
  error_message text,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  cost_usd_micros bigint not null default 0,
  latency_ms int not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index import_item_attempts_item_idx on public.import_item_attempts(item_id, attempt_no);

alter table public.import_item_attempts enable row level security;

create policy "import_item_attempts_own_all" on public.import_item_attempts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ---------- import_toc_entries ----------

create table public.import_toc_entries (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  item_id uuid not null references public.import_items(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default '',
  page_number int,
  confidence real not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index import_toc_entries_batch_idx on public.import_toc_entries(batch_id, title);

alter table public.import_toc_entries enable row level security;

create policy "import_toc_entries_own_all" on public.import_toc_entries
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create trigger import_toc_entries_updated
  before update on public.import_toc_entries
  for each row execute function public.touch_updated_at();

-- ---------- user_ocr_keys (BYOK) ----------
--
-- One row per (owner, provider). The raw key lives in `vault.secrets`;
-- we only store the vault row's id (plus a non-secret fingerprint that
-- the UI can show). The fingerprint is `last4:sha256[:8]` so users can
-- recognise a key without us ever decrypting it.

create table public.user_ocr_keys (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null
    check (provider in ('gemini', 'openai-compatible')),
  vault_secret_id uuid not null,
  key_fingerprint text not null,
  base_url text,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  primary key (owner_id, provider)
);

alter table public.user_ocr_keys enable row level security;

create policy "user_ocr_keys_own_read" on public.user_ocr_keys
  for select using (owner_id = auth.uid());
-- No insert / update / delete policies: writes go through ocr_key_set /
-- ocr_key_delete RPCs which run as security definer.

-- Even though it's never in a select policy projection, defense in
-- depth: explicitly revoke the column from `authenticated` so a
-- careless ".select('*')" can't leak the secret id either.
revoke select (vault_secret_id) on public.user_ocr_keys from authenticated;

-- ---------- ocr_key_set ----------

create or replace function public.ocr_key_set(
  p_provider text,
  p_raw_key text,
  p_base_url text default null
) returns void
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  caller uuid := auth.uid();
  existing_secret uuid;
  new_secret uuid;
  fingerprint text;
  secret_name text;
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if p_provider not in ('gemini', 'openai-compatible') then
    raise exception 'Unknown OCR provider %', p_provider using errcode = '22023';
  end if;
  if p_raw_key is null or length(btrim(p_raw_key)) < 8 then
    raise exception 'OCR key looks too short' using errcode = '22023';
  end if;

  fingerprint := right(p_raw_key, 4) || ':' ||
    substr(encode(extensions.digest(p_raw_key, 'sha256'), 'hex'), 1, 8);
  secret_name := 'ocr:' || caller::text || ':' || p_provider;

  select vault_secret_id into existing_secret
    from public.user_ocr_keys
    where owner_id = caller and provider = p_provider;

  if existing_secret is not null then
    perform vault.update_secret(existing_secret, p_raw_key);
    update public.user_ocr_keys
      set key_fingerprint = fingerprint,
          base_url = p_base_url,
          rotated_at = now()
      where owner_id = caller and provider = p_provider;
  else
    new_secret := vault.create_secret(p_raw_key, secret_name);
    insert into public.user_ocr_keys
      (owner_id, provider, vault_secret_id, key_fingerprint, base_url)
      values (caller, p_provider, new_secret, fingerprint, p_base_url);
  end if;
end;
$$;

revoke all on function public.ocr_key_set(text, text, text) from public;
grant execute on function public.ocr_key_set(text, text, text) to authenticated;

-- ---------- ocr_key_delete ----------

create or replace function public.ocr_key_delete(p_provider text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  caller uuid := auth.uid();
  existing_secret uuid;
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;

  select vault_secret_id into existing_secret
    from public.user_ocr_keys
    where owner_id = caller and provider = p_provider;
  if existing_secret is null then
    return;
  end if;

  delete from public.user_ocr_keys
    where owner_id = caller and provider = p_provider;
  delete from vault.secrets where id = existing_secret;
end;
$$;

revoke all on function public.ocr_key_delete(text) from public;
grant execute on function public.ocr_key_delete(text) to authenticated;

-- ---------- import_claim_next ----------
--
-- The worker calls this with its own id to lease up to `p_limit`
-- pending items for `p_lease_seconds`. Items whose lease has expired
-- are reclaimed in the same call so a crashed worker never wedges the
-- queue. `for update skip locked` keeps concurrent workers from
-- colliding on the same row.

create or replace function public.import_claim_next(
  p_worker_id text,
  p_batch_id uuid default null,
  p_lease_seconds int default 300,
  p_limit int default 8
) returns setof public.import_items
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.import_items
    set status = 'PENDING',
        claim_token = null
    where status = 'CLAIMED'
      and claim_expires_at < now();

  return query
    update public.import_items
      set status = 'CLAIMED',
          claim_token = p_worker_id,
          claim_expires_at = now() + make_interval(secs => p_lease_seconds)
      where id in (
        select id from public.import_items
          where status = 'PENDING'
            and (p_batch_id is null or batch_id = p_batch_id)
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;

revoke all on function public.import_claim_next(text, uuid, int, int) from public, authenticated, anon;
grant execute on function public.import_claim_next(text, uuid, int, int) to service_role;

-- ---------- import_complete ----------

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
begin
  select owner_id into item_owner
    from public.import_items
    where id = p_item_id and claim_token = p_claim_token;
  if item_owner is null then
    return false;
  end if;

  select coalesce(max(attempt_no), 0) + 1
    into next_attempt
    from public.import_item_attempts
    where item_id = p_item_id;

  insert into public.import_item_attempts (
    item_id, owner_id, attempt_no,
    provider, model, raw_response_path,
    error_kind, error_message,
    prompt_tokens, completion_tokens, cost_usd_micros, latency_ms,
    started_at, finished_at
  ) values (
    p_item_id, item_owner, next_attempt,
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

-- ---------- import_fail ----------

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
begin
  if p_next_state not in ('PENDING', 'NEEDS_FALLBACK', 'OCR_FAILED') then
    raise exception 'Invalid next state %', p_next_state using errcode = '22023';
  end if;

  select owner_id into item_owner
    from public.import_items
    where id = p_item_id and claim_token = p_claim_token;
  if item_owner is null then
    return false;
  end if;

  select coalesce(max(attempt_no), 0) + 1
    into next_attempt
    from public.import_item_attempts
    where item_id = p_item_id;

  insert into public.import_item_attempts (
    item_id, owner_id, attempt_no,
    provider, model, raw_response_path,
    error_kind, error_message,
    prompt_tokens, completion_tokens, cost_usd_micros, latency_ms,
    started_at, finished_at
  ) values (
    p_item_id, item_owner, next_attempt,
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

-- ---------- import_set_recitation_policy ----------

create or replace function public.import_set_recitation_policy(
  p_batch_id uuid,
  p_policy text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if p_policy not in ('FALLBACK', 'FAIL') then
    raise exception 'Policy must be FALLBACK or FAIL' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.import_batches
      where id = p_batch_id and owner_id = caller
  ) then
    raise exception 'Batch not found or not owned by caller' using errcode = '42501';
  end if;

  update public.import_batches
    set recitation_policy = p_policy
    where id = p_batch_id;

  -- Picking FALLBACK retroactively un-parks any items that had been
  -- routed to NEEDS_FALLBACK while the user was deciding. The
  -- `needs_fallback` hint stays set so the worker picks the batch's
  -- fallback_provider / fallback_model on the next attempt.
  if p_policy = 'FALLBACK' then
    update public.import_items
      set status = 'PENDING',
          needs_fallback = true
      where batch_id = p_batch_id and status = 'NEEDS_FALLBACK';
  end if;
end;
$$;

revoke all on function public.import_set_recitation_policy(uuid, text) from public;
grant execute on function public.import_set_recitation_policy(uuid, text) to authenticated;

-- ---------- ocr_kick ----------
--
-- Nudges the worker to drain the queue. Both an on-demand entry point
-- for the UI ("Process now") and the body of the pg_cron defensive
-- tick. The function URL + service-role key live in a single vault
-- secret named `import_worker_config` whose decrypted_secret is JSON
-- like `{"function_url": "...", "service_role_key": "..."}`. If the
-- secret isn't set (local dev where no Edge Function is deployed) the
-- RPC silently no-ops so kicks don't fail.

create or replace function public.ocr_kick(p_batch_id uuid default null)
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
  if p_batch_id is not null and caller is not null then
    if not exists (
      select 1 from public.import_batches
        where id = p_batch_id and owner_id = caller
    ) then
      raise exception 'Batch not found or not owned by caller' using errcode = '42501';
    end if;
  end if;

  select decrypted_secret::jsonb into cfg
    from vault.decrypted_secrets
    where name = 'import_worker_config'
    limit 1;
  if cfg is null then
    return;
  end if;

  url := cfg->>'function_url';
  key := cfg->>'service_role_key';
  if url is null or key is null then
    return;
  end if;

  perform net.http_post(
    url := url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('batch_id', p_batch_id)
  );
end;
$$;

revoke all on function public.ocr_kick(uuid) from public;
grant execute on function public.ocr_kick(uuid) to authenticated;

-- ---------- import_expire_stale_claims ----------

create or replace function public.import_expire_stale_claims()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  with reclaimed as (
    update public.import_items
      set status = 'PENDING',
          claim_token = null
      where status = 'CLAIMED'
        and claim_expires_at < now()
      returning 1
  )
  select count(*) into n from reclaimed;
  return n;
end;
$$;

revoke all on function public.import_expire_stale_claims() from public, authenticated, anon;
grant execute on function public.import_expire_stale_claims() to service_role;

-- ---------- Storage bucket + policies ----------

insert into storage.buckets (id, name, public)
  values ('imports', 'imports', false)
  on conflict (id) do nothing;

create policy "imports_read_own" on storage.objects
  for select
  using (
    bucket_id = 'imports'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "imports_write_own" on storage.objects
  for insert
  with check (
    bucket_id = 'imports'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "imports_update_own" on storage.objects
  for update
  using (
    bucket_id = 'imports'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "imports_delete_own" on storage.objects
  for delete
  using (
    bucket_id = 'imports'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------- Realtime publication ----------

alter publication supabase_realtime add table public.import_batches;
alter publication supabase_realtime add table public.import_items;
alter publication supabase_realtime add table public.import_item_attempts;
alter publication supabase_realtime add table public.import_toc_entries;

-- ---------- pg_cron tick ----------
--
-- 30s cadence — pg_cron 1.6+ supports sub-minute via the seconds field.
-- Wrapped in DO so a Postgres install without pg_cron (or without the
-- seconds-resolution patch) still applies the migration cleanly.
do $$ begin
  perform cron.schedule(
    'import-worker-tick',
    '30 seconds',
    $cron$ select public.ocr_kick(null); $cron$
  );
exception when others then null;
end $$;
