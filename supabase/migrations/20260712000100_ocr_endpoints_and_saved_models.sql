-- Multi-endpoint OCR keys + user-saved models + pick-a-model retries.
--
-- Motivation (observed in the wild): a page tripped Gemini's RECITATION
-- guardrail, fell back to the single configured OpenAI-compatible model,
-- and hit that provider's content filter too — dead end. Recovery needs
-- (a) more than one OpenAI-compatible endpoint per user (OpenAI, OpenRouter,
-- Groq… each with its own key + base URL), (b) a saved list of preferred
-- models to pick from, and (c) retry RPCs that accept the picked
-- provider/endpoint/model.
--
-- Everything here is rollout-safe: new columns are nullable / defaulted,
-- and every changed RPC keeps its old call shape working via defaulted
-- params (functions are DROPped before recreation — `create or replace`
-- can't change an argument list, and leaving the old overload would make
-- PostgREST named-arg calls ambiguous).

-- ---------- user_ocr_keys → multiple endpoints ----------
--
-- `endpoint` is a user-chosen slug that doubles as the display label
-- ('default', 'openrouter', 'groq'…). Existing rows become 'default', which
-- is also what every pre-existing caller resolves, so deployed workers and
-- clients keep working through the rollout. Gemini has exactly one API
-- surface, so it stays single-endpoint.

alter table public.user_ocr_keys
  add column endpoint text not null default 'default';
-- The original imports migration column-revoked vault_secret_id, which turns
-- the table-level SELECT into per-column grants — a column added later is
-- NOT covered and reads of it get "permission denied". Grant it explicitly.
grant select (endpoint) on public.user_ocr_keys to authenticated;
alter table public.user_ocr_keys
  add constraint user_ocr_keys_endpoint_slug
    check (endpoint ~ '^[a-z0-9][a-z0-9_-]{0,31}$');
alter table public.user_ocr_keys
  add constraint user_ocr_keys_gemini_single
    check (provider <> 'gemini' or endpoint = 'default');
alter table public.user_ocr_keys
  drop constraint user_ocr_keys_pkey;
alter table public.user_ocr_keys
  add primary key (owner_id, provider, endpoint);

-- ---------- ocr_key_set ----------

drop function if exists public.ocr_key_set(text, text, text);

create function public.ocr_key_set(
  p_provider text,
  p_raw_key text,
  p_base_url text default null,
  p_endpoint text default 'default'
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
  if p_endpoint is null or p_endpoint !~ '^[a-z0-9][a-z0-9_-]{0,31}$' then
    raise exception 'Endpoint must be a short lowercase slug' using errcode = '22023';
  end if;
  if p_provider = 'gemini' and p_endpoint <> 'default' then
    raise exception 'Gemini supports only the default endpoint' using errcode = '22023';
  end if;
  if p_raw_key is null or length(btrim(p_raw_key)) < 8 then
    raise exception 'OCR key looks too short' using errcode = '22023';
  end if;

  fingerprint := right(p_raw_key, 4) || ':' ||
    substr(encode(extensions.digest(p_raw_key, 'sha256'), 'hex'), 1, 8);
  -- Existing 'default' secrets keep their historical name (the update path
  -- never renames); only genuinely new endpoint rows mint suffixed names.
  secret_name := 'ocr:' || caller::text || ':' || p_provider ||
    case when p_endpoint = 'default' then '' else ':' || p_endpoint end;

  select vault_secret_id into existing_secret
    from public.user_ocr_keys
    where owner_id = caller and provider = p_provider and endpoint = p_endpoint;

  if existing_secret is not null then
    perform vault.update_secret(existing_secret, p_raw_key);
    update public.user_ocr_keys
      set key_fingerprint = fingerprint,
          base_url = p_base_url,
          rotated_at = now()
      where owner_id = caller and provider = p_provider and endpoint = p_endpoint;
  else
    new_secret := vault.create_secret(p_raw_key, secret_name);
    insert into public.user_ocr_keys
      (owner_id, provider, endpoint, vault_secret_id, key_fingerprint, base_url)
      values (caller, p_provider, p_endpoint, new_secret, fingerprint, p_base_url);
  end if;
end;
$$;

revoke all on function public.ocr_key_set(text, text, text, text) from public;
grant execute on function public.ocr_key_set(text, text, text, text) to authenticated;

-- ---------- ocr_key_delete ----------

drop function if exists public.ocr_key_delete(text);

create function public.ocr_key_delete(
  p_provider text,
  p_endpoint text default 'default'
) returns void
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
    where owner_id = caller and provider = p_provider and endpoint = coalesce(p_endpoint, 'default');
  if existing_secret is null then
    return;
  end if;

  delete from public.user_ocr_keys
    where owner_id = caller and provider = p_provider and endpoint = coalesce(p_endpoint, 'default');
  delete from vault.secrets where id = existing_secret;
end;
$$;

revoke all on function public.ocr_key_delete(text, text) from public;
grant execute on function public.ocr_key_delete(text, text) to authenticated;

-- ---------- ocr_resolve_key (legacy, pre-household resolver) ----------
-- Kept in sync for consistency; nothing but old deployments call it.

drop function if exists public.ocr_resolve_key(uuid, text);

create function public.ocr_resolve_key(
  p_owner_id uuid,
  p_provider text,
  p_endpoint text default 'default'
)
returns table(api_key text, base_url text)
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if p_owner_id is null then
    raise exception 'p_owner_id is required' using errcode = '22023';
  end if;
  if p_provider not in ('gemini', 'openai-compatible') then
    raise exception 'Unknown OCR provider %', p_provider using errcode = '22023';
  end if;

  return query
  select s.decrypted_secret::text as api_key,
         k.base_url
    from public.user_ocr_keys k
    join vault.decrypted_secrets s on s.id = k.vault_secret_id
   where k.owner_id = p_owner_id
     and k.provider = p_provider
     and k.endpoint = coalesce(p_endpoint, 'default');
end;
$$;

revoke all on function public.ocr_resolve_key(uuid, text, text) from public, authenticated, anon;
grant execute on function public.ocr_resolve_key(uuid, text, text) to service_role;

-- ---------- ocr_resolve_effective_key ----------
-- The worker's key lookup, now endpoint-aware. Household borrowing stays
-- single-endpoint: only the key owner's 'default' endpoint is ever served,
-- and only when the requested endpoint is null/'default' — a member's saved
-- model naming a private endpoint simply resolves no key.

drop function if exists public.ocr_resolve_effective_key(uuid, text);

create function public.ocr_resolve_effective_key(
  p_owner_id uuid,
  p_provider text,
  p_endpoint text default null
)
returns table(api_key text, base_url text, key_owner_id uuid)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_cfg public.household_ocr_config%rowtype;
  v_endpoint text := coalesce(p_endpoint, 'default');
begin
  if p_owner_id is null then
    raise exception 'p_owner_id is required' using errcode = '22023';
  end if;
  if p_provider not in ('gemini', 'openai-compatible') then
    raise exception 'Unknown OCR provider %', p_provider using errcode = '22023';
  end if;

  -- (a) Own key wins.
  return query
    select s.decrypted_secret::text, k.base_url, k.owner_id
      from public.user_ocr_keys k
      join vault.decrypted_secrets s on s.id = k.vault_secret_id
     where k.owner_id = p_owner_id and k.provider = p_provider and k.endpoint = v_endpoint;
  if found then
    return;
  end if;

  -- Household borrowing never serves a named endpoint.
  if v_endpoint <> 'default' then
    return;
  end if;

  -- (b) Else borrow the household key — only if sharing is enabled and the
  --     requesting member is ACTIVE in that household.
  select cfg.* into v_cfg
    from public.household_ocr_config cfg
    join public.household_members m on m.household_id = cfg.household_id
   where cfg.ocr_share_enabled = true
     and m.user_id = p_owner_id
     and m.left_at is null
   limit 1;

  if v_cfg.household_id is null then
    return;  -- no own key, no shared config: caller treats as "no key"
  end if;

  -- Provider containment: the borrowed key is only for the household's
  -- configured shared provider (or its fallback provider, which the
  -- recitation path legitimately uses). Deny anything else.
  if p_provider <> v_cfg.provider
     and (v_cfg.fallback_provider is null or p_provider <> v_cfg.fallback_provider) then
    return;
  end if;

  -- The key owner must still be an active member.
  if not exists (
    select 1 from public.household_members
    where household_id = v_cfg.household_id
      and user_id = v_cfg.key_owner_id
      and left_at is null
  ) then
    return;
  end if;

  return query
    select s.decrypted_secret::text, k.base_url, k.owner_id
      from public.user_ocr_keys k
      join vault.decrypted_secrets s on s.id = k.vault_secret_id
     where k.owner_id = v_cfg.key_owner_id and k.provider = p_provider and k.endpoint = 'default';
end;
$$;

revoke all on function public.ocr_resolve_effective_key(uuid, text, text) from public, authenticated, anon;
grant execute on function public.ocr_resolve_effective_key(uuid, text, text) to service_role;

-- ---------- import_batches: which endpoint each leg runs against ----------
-- NULL means 'default' everywhere, so pre-existing rows and old clients are
-- untouched. The endpoint must live on the batch (not be re-derived at
-- claim time): the worker needs to know WHICH key row to decrypt.

alter table public.import_batches add column default_endpoint text;
alter table public.import_batches add column fallback_endpoint text;

-- ---------- import_set_batch_fallback ----------

drop function if exists public.import_set_batch_fallback(uuid, text, text);

create function public.import_set_batch_fallback(
  p_batch_id uuid,
  p_provider text,
  p_model text,
  p_endpoint text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  trimmed_model text := nullif(trim(coalesce(p_model, '')), '');
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if p_batch_id is null then
    raise exception 'p_batch_id is required' using errcode = '22023';
  end if;
  if (p_provider is null) <> (trimmed_model is null) then
    raise exception 'Provider and model must both be set or both cleared'
      using errcode = '22023';
  end if;
  if p_provider is not null and p_provider not in ('gemini', 'openai-compatible') then
    raise exception 'Invalid provider %', p_provider using errcode = '22023';
  end if;

  update public.import_batches
     set fallback_provider = p_provider,
         fallback_model = trimmed_model,
         fallback_endpoint = case when p_provider is null then null else p_endpoint end
   where id = p_batch_id and owner_id = caller;

  if not found then
    raise exception 'Batch not found or not owned by caller' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.import_set_batch_fallback(uuid, text, text, text) from public;
grant execute on function public.import_set_batch_fallback(uuid, text, text, text) to authenticated;

-- ---------- import_reset_item ----------
-- New: endpoint snapshot params, plus p_use_fallback — a per-item "retry
-- with the batch's FALLBACK config" switch. Writing the picked model to the
-- batch *fallback* and resetting one item with needs_fallback=true retries
-- just that item on the picked model without disturbing the default config
-- the batch's other items keep using.

drop function if exists public.import_reset_item(uuid, text, text, text, text, text, uuid);

create function public.import_reset_item(
  p_item_id uuid,
  p_provider text default null,
  p_model text default null,
  p_prompt text default null,
  p_fallback_provider text default null,
  p_fallback_model text default null,
  p_key_owner_id uuid default null,
  p_endpoint text default null,
  p_fallback_endpoint text default null,
  p_use_fallback boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  owner uuid;
  bid uuid;
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if p_item_id is null then
    raise exception 'p_item_id is required' using errcode = '22023';
  end if;

  select owner_id, batch_id into owner, bid
    from public.import_items
   where id = p_item_id;
  if owner is null or owner <> caller then
    raise exception 'Item not found or not owned by caller' using errcode = '42501';
  end if;

  -- Re-snapshot the caller's current OCR config onto the batch so the
  -- worker re-reads fresh settings. Guarded on a supplied provider+model
  -- so a bare reset never wipes the batch's existing config.
  if p_provider is not null and p_model is not null then
    update public.import_batches
       set default_provider = p_provider,
           default_model = p_model,
           default_endpoint = p_endpoint,
           default_prompt = nullif(btrim(p_prompt), ''),
           fallback_provider = p_fallback_provider,
           fallback_model = p_fallback_model,
           fallback_endpoint = p_fallback_endpoint,
           key_owner_id = p_key_owner_id,
           updated_at = now()
     where id = bid
       and owner_id = caller;
  end if;

  update public.import_items
     set status = 'PENDING',
         claim_token = null,
         claim_expires_at = 'epoch'::timestamptz,
         attempts = 0,
         parsed_drafts_json = null,
         needs_fallback = coalesce(p_use_fallback, false),
         last_error = null,
         updated_at = now()
   where id = p_item_id;
end;
$$;

revoke all on function public.import_reset_item(uuid, text, text, text, text, text, uuid, text, text, boolean) from public;
grant execute on function public.import_reset_item(uuid, text, text, text, text, text, uuid, text, text, boolean) to authenticated;

-- ---------- import_retry_failures ----------

drop function if exists public.import_retry_failures(uuid, text, text, text, text, text, uuid);

create function public.import_retry_failures(
  p_batch_id uuid,
  p_provider text default null,
  p_model text default null,
  p_prompt text default null,
  p_fallback_provider text default null,
  p_fallback_model text default null,
  p_key_owner_id uuid default null,
  p_endpoint text default null,
  p_fallback_endpoint text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  reset_count integer;
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if p_batch_id is null then
    raise exception 'p_batch_id is required' using errcode = '22023';
  end if;

  -- Re-snapshot the caller's current OCR config onto the batch so the
  -- worker re-reads fresh settings. Guarded on a supplied provider+model
  -- so a bare reset never wipes the batch's existing config.
  if p_provider is not null and p_model is not null then
    update public.import_batches
       set default_provider = p_provider,
           default_model = p_model,
           default_endpoint = p_endpoint,
           default_prompt = nullif(btrim(p_prompt), ''),
           fallback_provider = p_fallback_provider,
           fallback_model = p_fallback_model,
           fallback_endpoint = p_fallback_endpoint,
           key_owner_id = p_key_owner_id,
           updated_at = now()
     where id = p_batch_id
       and owner_id = caller;
  end if;

  with updated as (
    update public.import_items
       set status = 'PENDING',
           claim_token = null,
           claim_expires_at = 'epoch'::timestamptz,
           attempts = 0,
           parsed_drafts_json = null,
           needs_fallback = false,
           last_error = null,
           updated_at = now()
     where batch_id = p_batch_id
       and owner_id = caller
       and status = 'OCR_FAILED'
    returning 1
  )
  select count(*) into reset_count from updated;

  return coalesce(reset_count, 0);
end;
$$;

revoke all on function public.import_retry_failures(uuid, text, text, text, text, text, uuid, text, text) from public;
grant execute on function public.import_retry_failures(uuid, text, text, text, text, text, uuid, text, text) to authenticated;

-- ---------- import_retry_recitation_failures ----------
-- New: an optional fallback override — the "retry these pages with a model
-- I just picked" path. When provider+model are supplied, the batch fallback
-- is overwritten first; the bare call keeps its old behavior (requires a
-- fallback to already exist).

drop function if exists public.import_retry_recitation_failures(uuid);

create function public.import_retry_recitation_failures(
  p_batch_id uuid,
  p_fallback_provider text default null,
  p_fallback_model text default null,
  p_fallback_endpoint text default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  batch_fb_provider text;
  batch_fb_model text;
  reset_count integer;
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if p_batch_id is null then
    raise exception 'p_batch_id is required' using errcode = '22023';
  end if;

  if p_fallback_provider is not null and p_fallback_model is not null then
    if p_fallback_provider not in ('gemini', 'openai-compatible') then
      raise exception 'Invalid provider %', p_fallback_provider using errcode = '22023';
    end if;
    update public.import_batches
       set fallback_provider = p_fallback_provider,
           fallback_model = p_fallback_model,
           fallback_endpoint = p_fallback_endpoint,
           updated_at = now()
     where id = p_batch_id and owner_id = caller;
  end if;

  select fallback_provider, fallback_model
    into batch_fb_provider, batch_fb_model
    from public.import_batches
   where id = p_batch_id and owner_id = caller;
  if batch_fb_provider is null or batch_fb_model is null then
    raise exception 'Batch has no fallback configured' using errcode = '22023';
  end if;

  update public.import_batches
     set recitation_policy = 'FALLBACK'
   where id = p_batch_id and owner_id = caller;

  with latest_attempt as (
    select distinct on (a.item_id)
           a.item_id,
           a.error_kind
      from public.import_item_attempts a
      join public.import_items i on i.id = a.item_id
     where i.batch_id = p_batch_id
       and i.owner_id = caller
       and i.status = 'OCR_FAILED'
     order by a.item_id, a.attempt_no desc
  ),
  updated as (
    update public.import_items
       set status = 'PENDING',
           needs_fallback = true,
           claim_token = null,
           claim_expires_at = 'epoch'::timestamptz,
           attempts = 0,
           last_error = null,
           parsed_drafts_json = null
     where batch_id = p_batch_id
       and owner_id = caller
       and status = 'OCR_FAILED'
       and id in (select item_id from latest_attempt where error_kind = 'RECITATION')
    returning 1
  )
  select count(*) into reset_count from updated;

  return coalesce(reset_count, 0);
end;
$$;

revoke all on function public.import_retry_recitation_failures(uuid, text, text, text) from public;
grant execute on function public.import_retry_recitation_failures(uuid, text, text, text) to authenticated;

-- ---------- user_ocr_models: the saved "preferred models" list ----------
-- Plain RLS table (no vault material, no RPCs needed — matches the
-- user_ocr_prefs direct-access pattern). Feeds the retry picker's dropdown.

create table public.user_ocr_models (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('gemini', 'openai-compatible')),
  endpoint text not null default 'default'
    check (endpoint ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  model text not null check (length(btrim(model)) > 0),
  label text,
  sort_index int not null default 0,
  created_at timestamptz not null default now(),
  unique (owner_id, provider, endpoint, model)
);

alter table public.user_ocr_models enable row level security;

create policy "user_ocr_models_own_all" on public.user_ocr_models
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant select, insert, update, delete on public.user_ocr_models to authenticated;
