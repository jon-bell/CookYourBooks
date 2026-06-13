-- Collection cover generation queue (Gemini image model).
--
-- Sibling of recipe_cover_jobs (20260626000100), but for a *collection-level*
-- cover: Gemini invents a cookbook cover from the collection title + its table
-- of contents (every recipe title). One job per collection. Drained by the same
-- import-worker cover loop, same claim/lease discipline.
--
--   owner_id     = the collection's owner (whose covers/{owner}/collections path
--                  + recipe_collections row get the cover)
--   requested_by = the member who launched the job (whose key pays, whose
--                  cost-center row it becomes)
--
-- Cost is metered into the existing 'cover_image' LLM Cost Center feature with
-- produced_kind = 'COLLECTION_ID' (vs 'RECIPE_ID' for recipe covers), so no
-- cost-center constraint/RPC change is needed to distinguish the two.

create table public.collection_cover_jobs (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.recipe_collections(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'CLAIMED', 'DONE', 'FAILED')),
  claim_token text,
  claim_expires_at timestamptz not null default 'epoch'::timestamptz,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One in-flight job per collection (coalesce double-clicks).
create unique index collection_cover_jobs_one_pending
  on public.collection_cover_jobs(collection_id)
  where status in ('PENDING', 'CLAIMED');

create index collection_cover_jobs_claim_scan_idx
  on public.collection_cover_jobs(status, claim_expires_at);
create index collection_cover_jobs_requested_by_idx
  on public.collection_cover_jobs(requested_by, status);
create index collection_cover_jobs_owner_status_idx
  on public.collection_cover_jobs(owner_id, status);

alter table public.collection_cover_jobs enable row level security;

create policy "collection_cover_jobs_read" on public.collection_cover_jobs
  for select using (
    requested_by = (select auth.uid())
    or owner_id = (select auth.uid())
  );

create trigger collection_cover_jobs_updated
  before update on public.collection_cover_jobs
  for each row execute function public.touch_updated_at();

-- ---------- collection_cover_enqueue ----------
-- Enqueue a single PENDING job for a collection the CALLER can read (own, or
-- shared into the caller's household via the JWT claim — same predicate as the
-- claim-based recipe_collections read policy). Security definer so it can insert
-- into the queue, but re-applies the read predicate so a caller can't enqueue a
-- cover for a collection they can't see.
create or replace function public.collection_cover_enqueue(
  p_collection_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_household uuid := nullif(auth.jwt() ->> 'household_id', '')::uuid;
  v_count integer;
begin
  if v_caller is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_collection_id is null then
    raise exception 'p_collection_id is required' using errcode = '22023';
  end if;

  with inserted as (
    insert into public.collection_cover_jobs (collection_id, owner_id, requested_by)
    select c.id, c.owner_id, v_caller
      from public.recipe_collections c
     where c.id = p_collection_id
       and (c.owner_id = v_caller
            or (c.owner_id <> v_caller and c.household_id = v_household))
    on conflict (collection_id) where status in ('PENDING', 'CLAIMED') do nothing
    returning 1
  )
  select count(*) into v_count from inserted;
  return v_count;
end;
$$;

revoke all on function public.collection_cover_enqueue(uuid) from public, anon;
grant execute on function public.collection_cover_enqueue(uuid) to authenticated;

-- ---------- collection_cover_claim_next (service-role) ----------
create or replace function public.collection_cover_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 8
) returns setof public.collection_cover_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.collection_cover_jobs
    set status = 'PENDING', claim_token = null
    where status = 'CLAIMED' and claim_expires_at < now();

  return query
    update public.collection_cover_jobs
      set status = 'CLAIMED',
          claim_token = p_worker_id,
          claim_expires_at = now() + make_interval(secs => p_lease_seconds),
          attempts = attempts + 1,
          updated_at = now()
      where id in (
        select id from public.collection_cover_jobs
          where status = 'PENDING'
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;

revoke all on function public.collection_cover_claim_next(text, int, int) from public, authenticated, anon;
grant execute on function public.collection_cover_claim_next(text, int, int) to service_role;

-- ---------- collection_cover_complete (service-role) ----------
-- Stamps the generated cover path onto the collection (the recipe_collections
-- updated_at trigger bumps updated_at so it pulls to the owner AND household
-- co-members) and marks the job DONE.
create or replace function public.collection_cover_complete(
  p_job_id uuid,
  p_claim_token text,
  p_cover_path text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_collection uuid;
begin
  select collection_id into v_collection
    from public.collection_cover_jobs
    where id = p_job_id
      and claim_token = p_claim_token
      and status = 'CLAIMED'
    for update;
  if v_collection is null then
    return false;
  end if;

  update public.recipe_collections set cover_image_path = p_cover_path where id = v_collection;

  update public.collection_cover_jobs set
    status = 'DONE',
    last_error = null,
    claim_token = null,
    updated_at = now()
    where id = p_job_id;

  return true;
end;
$$;

revoke all on function public.collection_cover_complete(uuid, text, text) from public, authenticated, anon;
grant execute on function public.collection_cover_complete(uuid, text, text) to service_role;

-- ---------- collection_cover_fail (service-role) ----------
create or replace function public.collection_cover_fail(
  p_job_id uuid,
  p_claim_token text,
  p_error text,
  p_next_state text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_next_state not in ('PENDING', 'FAILED') then
    raise exception 'Invalid next state %', p_next_state using errcode = '22023';
  end if;
  update public.collection_cover_jobs set
    status = p_next_state,
    last_error = p_error,
    claim_token = null,
    updated_at = now()
    where id = p_job_id
      and claim_token = p_claim_token
      and status = 'CLAIMED';
  return found;
end;
$$;

revoke all on function public.collection_cover_fail(uuid, text, text, text) from public, authenticated, anon;
grant execute on function public.collection_cover_fail(uuid, text, text, text) to service_role;

-- ---------- worker_has_pending_work: include collection cover jobs ----------
create or replace function public.worker_has_pending_work()
returns boolean
language sql
security definer
set search_path to 'public'
stable
as $$
  select
       exists (select 1 from public.import_items
                 where status = 'PENDING')
    or exists (select 1 from public.import_items
                 where status = 'CLAIMED' and claim_expires_at < now())
    or exists (select 1 from public.import_item_variant_results
                 where status = 'PENDING')
    or exists (select 1 from public.import_item_variant_results
                 where status = 'CLAIMED' and claim_expires_at < now())
    or exists (select 1 from public.bakeoff_variants
                 where status = 'PENDING')
    or exists (select 1 from public.bakeoff_variants
                 where status = 'CLAIMED' and claim_expires_at < now())
    or exists (select 1 from public.rewrite_jobs
                 where status = 'PENDING')
    or exists (select 1 from public.rewrite_jobs
                 where status = 'CLAIMED' and claim_expires_at < now())
    or exists (select 1 from public.recipe_cover_jobs
                 where status = 'PENDING')
    or exists (select 1 from public.recipe_cover_jobs
                 where status = 'CLAIMED' and claim_expires_at < now())
    or exists (select 1 from public.collection_cover_jobs
                 where status = 'PENDING')
    or exists (select 1 from public.collection_cover_jobs
                 where status = 'CLAIMED' and claim_expires_at < now());
$$;
revoke all on function public.worker_has_pending_work() from public;

-- Data API grants (CLI >= 2.106.0 no longer auto-grants on public).
grant select on public.collection_cover_jobs to authenticated;

-- Stream the jobs table so the cover dialog can watch progress live.
alter publication supabase_realtime add table public.collection_cover_jobs;
