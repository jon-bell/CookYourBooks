-- Recipe cover generation queue (Gemini image model).
--
-- Bulk cover generation (single recipe / whole collection / whole library) is
-- a queued job drained by the import-worker Edge Function — the same
-- claim/lease discipline as recipe_embedding_jobs (20260605000100). Any active
-- household member can generate covers for recipes they can read; the worker
-- resolves the *initiator's* Gemini key, uploads the image into the recipe
-- owner's `covers` path, stamps recipes.cover_image_path (under service role,
-- so co-members' recipes update too), and meters the spend into the LLM Cost
-- Center under the initiator (20260626000200).
--
--   owner_id     = the recipe's owner (whose `covers/{owner}/...` path + row)
--   requested_by = the member who launched the job (whose key pays, whose
--                  cost-center row it becomes)

create table public.recipe_cover_jobs (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
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

-- Coalesce repeat enqueues for the same recipe while one is in flight (a user
-- double-clicking "generate", or a recipe caught by both a collection-scope
-- and a library-scope enqueue). Once DONE/FAILED it leaves the partial set so
-- a later regenerate re-inserts cleanly.
create unique index recipe_cover_jobs_one_pending
  on public.recipe_cover_jobs(recipe_id)
  where status in ('PENDING', 'CLAIMED');

create index recipe_cover_jobs_claim_scan_idx
  on public.recipe_cover_jobs(status, claim_expires_at);
create index recipe_cover_jobs_requested_by_idx
  on public.recipe_cover_jobs(requested_by, status);
create index recipe_cover_jobs_owner_status_idx
  on public.recipe_cover_jobs(owner_id, status);

alter table public.recipe_cover_jobs enable row level security;

-- The initiator watches their own job board; the recipe owner sees covers
-- being generated against their recipes. No household-claim branch needed —
-- progress is operational, not library content.
create policy "recipe_cover_jobs_read" on public.recipe_cover_jobs
  for select using (
    requested_by = (select auth.uid())
    or owner_id = (select auth.uid())
  );

create trigger recipe_cover_jobs_updated
  before update on public.recipe_cover_jobs
  for each row execute function public.touch_updated_at();

-- ---------- cover_jobs_enqueue ----------
-- Enqueue PENDING jobs for every recipe in scope that the CALLER can read
-- (own, or shared into the caller's household via the JWT claim — the same
-- predicate as the claim-based recipes read policy, 20260623000200). Runs
-- security definer so it can insert into the queue, but re-applies the read
-- predicate so a caller can't enqueue covers for recipes they can't see.
--   p_scope: 'recipe' (p_target_id = recipe id)
--          | 'collection' (p_target_id = collection id)
--          | 'library' (p_target_id ignored — the CALLER's OWN recipes)
-- 'recipe'/'collection' admit household-shared targets (a co-member can
-- generate a cover for a recipe they can read); 'library' is "my whole
-- library" so it's scoped to owned recipes — it won't spend the caller's key
-- across co-members' libraries.
create or replace function public.cover_jobs_enqueue(
  p_scope text,
  p_target_id uuid default null
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
  if p_scope not in ('recipe', 'collection', 'library') then
    raise exception 'Unknown scope %', p_scope using errcode = '22023';
  end if;
  if p_scope in ('recipe', 'collection') and p_target_id is null then
    raise exception 'p_target_id is required for scope %', p_scope using errcode = '22023';
  end if;

  with inserted as (
    insert into public.recipe_cover_jobs (recipe_id, owner_id, requested_by)
    select r.id, r.owner_id, v_caller
      from public.recipes r
     where case p_scope
             -- 'recipe'/'collection': any recipe the caller can read.
             when 'recipe' then
               r.id = p_target_id
               and (r.owner_id = v_caller
                    or (r.owner_id <> v_caller and r.household_id = v_household))
             when 'collection' then
               r.collection_id = p_target_id
               and (r.owner_id = v_caller
                    or (r.owner_id <> v_caller and r.household_id = v_household))
             -- 'library': only the caller's own recipes.
             else r.owner_id = v_caller
           end
    on conflict (recipe_id) where status in ('PENDING', 'CLAIMED') do nothing
    returning 1
  )
  select count(*) into v_count from inserted;
  return v_count;
end;
$$;

revoke all on function public.cover_jobs_enqueue(text, uuid) from public, anon;
grant execute on function public.cover_jobs_enqueue(text, uuid) to authenticated;

-- ---------- cover_claim_next (service-role) ----------
create or replace function public.cover_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 8
) returns setof public.recipe_cover_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.recipe_cover_jobs
    set status = 'PENDING', claim_token = null
    where status = 'CLAIMED' and claim_expires_at < now();

  return query
    update public.recipe_cover_jobs
      set status = 'CLAIMED',
          claim_token = p_worker_id,
          claim_expires_at = now() + make_interval(secs => p_lease_seconds),
          attempts = attempts + 1,
          updated_at = now()
      where id in (
        select id from public.recipe_cover_jobs
          where status = 'PENDING'
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;

revoke all on function public.cover_claim_next(text, int, int) from public, authenticated, anon;
grant execute on function public.cover_claim_next(text, int, int) to service_role;

-- ---------- cover_complete (service-role) ----------
-- Stamps the generated cover path onto the recipe (bumping updated_at via
-- touch_updated_at so it pulls to the owner AND household co-members) and
-- marks the job DONE. Same claim-token / status race posture as embed_complete.
create or replace function public.cover_complete(
  p_job_id uuid,
  p_claim_token text,
  p_cover_path text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipe uuid;
begin
  select recipe_id into v_recipe
    from public.recipe_cover_jobs
    where id = p_job_id
      and claim_token = p_claim_token
      and status = 'CLAIMED'
    for update;
  if v_recipe is null then
    return false;
  end if;

  update public.recipes set cover_image_path = p_cover_path where id = v_recipe;

  update public.recipe_cover_jobs set
    status = 'DONE',
    last_error = null,
    claim_token = null,
    updated_at = now()
    where id = p_job_id;

  return true;
end;
$$;

revoke all on function public.cover_complete(uuid, text, text) from public, authenticated, anon;
grant execute on function public.cover_complete(uuid, text, text) to service_role;

-- ---------- cover_fail (service-role) ----------
create or replace function public.cover_fail(
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
  update public.recipe_cover_jobs set
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

revoke all on function public.cover_fail(uuid, text, text, text) from public, authenticated, anon;
grant execute on function public.cover_fail(uuid, text, text, text) to service_role;

-- ---------- worker_has_pending_work: include cover jobs ----------
-- Re-create (20260619000000) adding the cover queue so the cron-driven kick
-- wakes the worker when covers are queued but stays a no-op on an idle system.
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
                 where status = 'CLAIMED' and claim_expires_at < now());
$$;
revoke all on function public.worker_has_pending_work() from public;

-- ---------- cover_kick ----------
-- Mirrors embed_kick / ocr_kick: reuses the single import_worker_config vault
-- secret (one Edge Function carries every drain loop). The NULL-id (cron)
-- path is covered by the worker_has_pending_work guard inside the cron body.
create or replace function public.cover_kick()
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  cfg jsonb;
  url text;
  key text;
begin
  select decrypted_secret::jsonb into cfg
    from vault.decrypted_secrets
    where name = 'import_worker_config'
    limit 1;
  if cfg is null then
    raise exception 'COVER_WORKER_NOT_CONFIGURED: vault secret `import_worker_config` is not set. See CLAUDE.md "Setting up the OCR worker".';
  end if;
  url := cfg->>'function_url';
  key := cfg->>'service_role_key';
  if url is null or key is null then
    raise exception 'COVER_WORKER_NOT_CONFIGURED: vault secret `import_worker_config` is missing function_url or service_role_key.';
  end if;

  perform net.http_post(
    url := url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('cover', true)
  );
end;
$$;

revoke all on function public.cover_kick() from public;
grant execute on function public.cover_kick() to authenticated;

-- ---------- pg_cron tick ----------
do $$ begin
  perform cron.schedule(
    'cover-worker-tick',
    '30 seconds',
    $cron$
      do $cronbody$
      begin
        if public.worker_has_pending_work() then
          perform public.cover_kick();
        end if;
      exception when others then
        null;
      end
      $cronbody$;
    $cron$
  );
exception when others then null;
end $$;

-- Stream the jobs table so the bulk-generation UI sees progress live.
alter publication supabase_realtime add table public.recipe_cover_jobs;
