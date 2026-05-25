-- Bakeoff as import batch: a BAKEOFF batch uploads pages like any import,
-- runs each page (or merged group) through N OCR variant configs, then the
-- user picks a winning variant per page before saving recipes.

-- ---------- import_batches.batch_kind ----------

alter table public.import_batches
  add column if not exists batch_kind text not null default 'STANDARD'
    check (batch_kind in ('STANDARD', 'BAKEOFF'));

-- ---------- import_items: winner + bakeoff statuses ----------

alter table public.import_items
  add column if not exists selected_variant_id uuid;

alter table public.import_items
  drop constraint if exists import_items_status_check;

alter table public.import_items
  add constraint import_items_status_check
  check (status in (
    'AWAITING_GROUPING',
    'BAKEOFF_PENDING',
    'BAKEOFF_READY',
    'PENDING', 'CLAIMED', 'OCR_DONE', 'NEEDS_FALLBACK', 'OCR_FAILED',
    'REVIEWED', 'DISCARDED'
  ));

-- ---------- import_batch_variants ----------
-- Variant matrix configs for a bakeoff batch (replaces bakeoff_variants).

create table public.import_batch_variants (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  sort_index int not null default 0,
  name text not null default '',
  provider text not null
    check (provider in ('gemini', 'openai-compatible')),
  model text not null,
  prompt text not null,
  base_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.import_batch_variants enable row level security;

create policy "import_batch_variants_read_own" on public.import_batch_variants
  for select using (auth.uid() = owner_id);

create index import_batch_variants_batch_idx
  on public.import_batch_variants(batch_id, sort_index);

alter table public.import_items
  add constraint import_items_selected_variant_fkey
  foreign key (selected_variant_id) references public.import_batch_variants(id)
  on delete set null;

-- ---------- import_item_variant_results ----------
-- One OCR job per (page item × variant). Worker claims these instead of
-- running the normal single-model import path for bakeoff batches.

create table public.import_item_variant_results (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.import_items(id) on delete cascade,
  variant_id uuid not null references public.import_batch_variants(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'CLAIMED', 'DONE', 'FAILED')),
  claim_token text,
  claim_expires_at timestamptz not null default 'epoch'::timestamptz,
  attempts int not null default 0,
  drafts jsonb,
  raw_text text,
  prompt_tokens int,
  completion_tokens int,
  cost_usd_micros int,
  latency_ms int,
  error_kind text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, variant_id)
);

alter table public.import_item_variant_results enable row level security;

create policy "import_item_variant_results_read_own"
  on public.import_item_variant_results
  for select using (auth.uid() = owner_id);

create index import_item_variant_results_claim_idx
  on public.import_item_variant_results(status, claim_expires_at);

create index import_item_variant_results_item_idx
  on public.import_item_variant_results(item_id);

alter publication supabase_realtime add table public.import_batch_variants;
alter publication supabase_realtime add table public.import_item_variant_results;

-- ---------- import_bakeoff_seed ----------
-- After the client uploads pages, call this once with the variant matrix.
-- Creates variant rows + pending result rows for every non-discarded item
-- already in BAKEOFF_PENDING.

create or replace function public.import_bakeoff_seed(
  p_batch_id uuid,
  p_variants jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  batch_owner uuid;
  batch_kind text;
  v_id uuid;
  elem jsonb;
  ord int;
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

  select owner_id, batch_kind into batch_owner, batch_kind
    from public.import_batches where id = p_batch_id;
  if batch_owner is null or batch_owner <> caller then
    raise exception 'Batch not found';
  end if;
  if batch_kind <> 'BAKEOFF' then
    raise exception 'Batch is not a bakeoff';
  end if;

  -- Replace any prior variant config (idempotent re-seed).
  delete from public.import_batch_variants where batch_id = p_batch_id;

  ord := 0;
  for elem in select * from jsonb_array_elements(p_variants)
  loop
    insert into public.import_batch_variants (
      batch_id, owner_id, sort_index, name, provider, model, prompt, base_url
    ) values (
      p_batch_id,
      caller,
      ord,
      coalesce(elem->>'name', ''),
      coalesce(elem->>'provider', 'gemini'),
      coalesce(elem->>'model', ''),
      coalesce(elem->>'prompt', ''),
      elem->>'base_url'
    );
    ord := ord + 1;
  end loop;

  insert into public.import_item_variant_results (item_id, variant_id, owner_id)
  select i.id, v.id, caller
    from public.import_items i
    cross join public.import_batch_variants v
   where i.batch_id = p_batch_id
     and i.owner_id = caller
     and i.status = 'BAKEOFF_PENDING'
     and i.status <> 'DISCARDED'
  on conflict (item_id, variant_id) do nothing;
end;
$$;

revoke all on function public.import_bakeoff_seed(uuid, jsonb) from public, anon;
grant execute on function public.import_bakeoff_seed(uuid, jsonb) to authenticated;

-- ---------- import_variant_claim_next ----------

create or replace function public.import_variant_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 4
) returns setof public.import_item_variant_results
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.import_item_variant_results
    set status = 'PENDING', claim_token = null
    where status = 'CLAIMED' and claim_expires_at < now();

  return query
    update public.import_item_variant_results
      set status = 'CLAIMED',
          claim_token = p_worker_id,
          claim_expires_at = now() + make_interval(secs => p_lease_seconds),
          attempts = attempts + 1,
          updated_at = now()
      where id in (
        select r.id from public.import_item_variant_results r
          where r.status = 'PENDING'
          order by r.created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;

revoke all on function public.import_variant_claim_next(text, int, int)
  from public, authenticated, anon;
grant execute on function public.import_variant_claim_next(text, int, int) to service_role;

-- ---------- import_variant_complete / fail ----------

create or replace function public.import_variant_complete(
  p_result_id uuid,
  p_claim_token text,
  p_payload jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid;
  pending int;
  failed int;
  total int;
begin
  update public.import_item_variant_results set
    status = 'DONE',
    drafts = p_payload->'drafts',
    raw_text = p_payload->>'raw_text',
    prompt_tokens = nullif((p_payload->>'prompt_tokens')::int, 0),
    completion_tokens = nullif((p_payload->>'completion_tokens')::int, 0),
    cost_usd_micros = (p_payload->>'cost_usd_micros')::int,
    latency_ms = (p_payload->>'latency_ms')::int,
    error_kind = 'OK',
    error_message = null,
    claim_token = null,
    updated_at = now()
    where id = p_result_id and claim_token = p_claim_token
    returning item_id into v_item_id;

  if v_item_id is null then
    return false;
  end if;

  select
    count(*) filter (where status in ('PENDING', 'CLAIMED')),
    count(*) filter (where status = 'FAILED'),
    count(*)
    into pending, failed, total
    from public.import_item_variant_results
   where item_id = v_item_id;

  if pending = 0 and total > 0 then
    update public.import_items set
      status = case when failed = total then 'OCR_FAILED' else 'BAKEOFF_READY' end,
      updated_at = now()
      where id = v_item_id and status = 'BAKEOFF_PENDING';
  end if;

  return true;
end;
$$;

revoke all on function public.import_variant_complete(uuid, text, jsonb)
  from public, authenticated, anon;
grant execute on function public.import_variant_complete(uuid, text, jsonb) to service_role;

create or replace function public.import_variant_fail(
  p_result_id uuid,
  p_claim_token text,
  p_error_kind text,
  p_error_message text,
  p_latency_ms int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid;
  pending int;
  failed int;
  total int;
begin
  update public.import_item_variant_results set
    status = 'FAILED',
    error_kind = p_error_kind,
    error_message = p_error_message,
    latency_ms = p_latency_ms,
    claim_token = null,
    updated_at = now()
    where id = p_result_id and claim_token = p_claim_token
    returning item_id into v_item_id;

  if v_item_id is null then
    return false;
  end if;

  select
    count(*) filter (where status in ('PENDING', 'CLAIMED')),
    count(*) filter (where status = 'FAILED'),
    count(*)
    into pending, failed, total
    from public.import_item_variant_results
   where item_id = v_item_id;

  if pending = 0 and total > 0 then
    update public.import_items set
      status = case when failed = total then 'OCR_FAILED' else 'BAKEOFF_READY' end,
      updated_at = now()
      where id = v_item_id and status = 'BAKEOFF_PENDING';
  end if;

  return true;
end;
$$;

revoke all on function public.import_variant_fail(uuid, text, text, text, int)
  from public, authenticated, anon;
grant execute on function public.import_variant_fail(uuid, text, text, text, int) to service_role;

-- ---------- import_bakeoff_select_winner ----------

create or replace function public.import_bakeoff_select_winner(
  p_item_id uuid,
  p_variant_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  r public.import_item_variant_results%rowtype;
begin
  if caller is null then
    raise exception 'Not authenticated';
  end if;

  select * into r
    from public.import_item_variant_results
   where item_id = p_item_id
     and variant_id = p_variant_id
     and owner_id = caller;

  if not found then
    raise exception 'Variant result not found';
  end if;
  if r.status <> 'DONE' then
    raise exception 'Variant has not finished successfully';
  end if;

  update public.import_items set
    selected_variant_id = p_variant_id,
    parsed_drafts_json = r.drafts,
    model_used = (
      select v.model from public.import_batch_variants v where v.id = p_variant_id
    ),
    prompt_tokens = coalesce(r.prompt_tokens, 0),
    completion_tokens = coalesce(r.completion_tokens, 0),
    cost_usd_micros = coalesce(r.cost_usd_micros, 0),
    status = 'OCR_DONE',
    updated_at = now()
   where id = p_item_id
     and owner_id = caller
     and status = 'BAKEOFF_READY';
end;
$$;

revoke all on function public.import_bakeoff_select_winner(uuid, uuid) from public, anon;
grant execute on function public.import_bakeoff_select_winner(uuid, uuid) to authenticated;

-- ---------- import_bakeoff_promote (replaces bakeoff_promote) ----------

create or replace function public.import_bakeoff_promote(
  p_variant_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  v public.import_batch_variants%rowtype;
begin
  if caller is null then
    raise exception 'Not authenticated';
  end if;
  select * into v from public.import_batch_variants
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

revoke all on function public.import_bakeoff_promote(uuid) from public, anon;
grant execute on function public.import_bakeoff_promote(uuid) to authenticated;

-- Keep bakeoff_promote working for legacy standalone bakeoffs.
create or replace function public.bakeoff_promote(p_variant_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  v public.bakeoff_variants%rowtype;
  v_exists int;
begin
  if caller is null then
    raise exception 'Not authenticated';
  end if;

  select count(*) into v_exists
    from public.import_batch_variants
   where id = p_variant_id and owner_id = caller;
  if v_exists > 0 then
    perform public.import_bakeoff_promote(p_variant_id);
    return;
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

-- ---------- import_finalize_grouping: bakeoff batches → BAKEOFF_PENDING ----------

create or replace function public.import_finalize_grouping(
  p_batch_id uuid,
  p_groups jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  batch_owner uuid;
  v_batch_kind text;
  group_elem jsonb;
  group_ids uuid[];
  primary_id uuid;
  absorb_ids uuid[];
  extras text[];
  seen_ids uuid[] := array[]::uuid[];
  next_status text;
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if p_batch_id is null then
    raise exception 'p_batch_id is required' using errcode = '22023';
  end if;
  if p_groups is null or jsonb_typeof(p_groups) <> 'array' then
    raise exception 'p_groups must be a jsonb array of arrays' using errcode = '22023';
  end if;

  select owner_id, batch_kind into batch_owner, v_batch_kind
    from public.import_batches where id = p_batch_id;
  if batch_owner is null or batch_owner <> caller then
    raise exception 'Batch not found or not owned by caller' using errcode = '42501';
  end if;

  next_status := case when v_batch_kind = 'BAKEOFF' then 'BAKEOFF_PENDING' else 'PENDING' end;

  for group_elem in select * from jsonb_array_elements(p_groups)
  loop
    if jsonb_typeof(group_elem) <> 'array' then
      raise exception 'Each group must be a jsonb array' using errcode = '22023';
    end if;
    select array_agg((value)::text::uuid)
      into group_ids
      from jsonb_array_elements_text(group_elem);
    if group_ids is null or array_length(group_ids, 1) is null then
      continue;
    end if;
    primary_id := group_ids[1];
    absorb_ids := group_ids[2:array_length(group_ids, 1)];

    if seen_ids && group_ids then
      raise exception 'Item id appears in more than one group' using errcode = '22023';
    end if;
    seen_ids := seen_ids || group_ids;

    if absorb_ids is not null and array_length(absorb_ids, 1) > 0 then
      select coalesce(array_agg(s.storage_path order by s.page_index), array[]::text[])
        into extras
        from (
          select i.storage_path, i.page_index
            from public.import_items i
           where i.id = any(absorb_ids)
             and i.owner_id = caller
             and i.batch_id = p_batch_id
             and i.id <> primary_id
        ) s;

      if array_length(extras, 1) is null then
        raise exception 'No absorb-able items found in group' using errcode = '22023';
      end if;

      update public.import_items
         set extra_storage_paths = extra_storage_paths || extras,
             updated_at = now()
       where id = primary_id
         and owner_id = caller
         and batch_id = p_batch_id;

      update public.import_items
         set status = 'DISCARDED',
             updated_at = now()
       where id = any(absorb_ids)
         and owner_id = caller
         and batch_id = p_batch_id;
    end if;
  end loop;

  update public.import_items
     set status = next_status,
         updated_at = now()
   where batch_id = p_batch_id
     and owner_id = caller
     and status = 'AWAITING_GROUPING';

  -- If variants were already seeded, create result rows for newly released items.
  if v_batch_kind = 'BAKEOFF' then
    insert into public.import_item_variant_results (item_id, variant_id, owner_id)
    select i.id, v.id, caller
      from public.import_items i
      cross join public.import_batch_variants v
     where i.batch_id = p_batch_id
       and i.owner_id = caller
       and i.status = 'BAKEOFF_PENDING'
    on conflict (item_id, variant_id) do nothing;
  end if;
end;
$$;
