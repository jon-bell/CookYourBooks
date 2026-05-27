-- Semantic recipe search via embeddings.
--
-- Recipes get a 384-dim vector embedding (bge-small-en-v1.5) keyed off
-- a deterministic SHA-256 of the recipe's searchable text (title,
-- description, ingredients, notes, book title, equipment — instructions
-- are deliberately excluded). The same model runs in three places:
--
--   * the import-worker Edge Function (batch backfill / on-trigger),
--   * the browser at recipe save time,
--   * the browser at query time.
--
-- This table is the canonical store. Local SQLite mirrors the rows
-- pulled here so the search runtime never round-trips the network. The
-- search itself happens entirely in the browser (cosine over the local
-- mirror) — pgvector is the durable cache, not the query engine.
--
-- The jobs table mirrors rewrite_jobs (20260604000001_rewrite_jobs.sql)
-- exactly so the worker code can reuse the same claim/lease pattern.

create extension if not exists vector;

-- ---------- recipe_embeddings ----------

create table public.recipe_embeddings (
  recipe_id uuid primary key references public.recipes(id) on delete cascade,
  embedding vector(384) not null,
  text_hash text not null,
  model text not null,
  embedded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- HNSW for cosine similarity. /search itself doesn't use this — it does
-- the math locally — but Discover and future cross-user features will
-- want server-side similarity. Cheap to maintain on the kind of write
-- volume a personal recipe library generates.
create index recipe_embeddings_hnsw
  on public.recipe_embeddings using hnsw (embedding vector_cosine_ops);

alter table public.recipe_embeddings enable row level security;

-- Anyone who can read the recipe can read its embedding. That mirrors
-- the recipes / recipe_collections RLS without us having to inline the
-- same predicate twice — `exists` short-circuits as soon as the join
-- proves visibility.
create policy "recipe_embeddings_read" on public.recipe_embeddings
  for select using (
    exists (
      select 1
        from public.recipes r
        join public.recipe_collections c on c.id = r.collection_id
        where r.id = recipe_embeddings.recipe_id
          and (c.owner_id = auth.uid() or c.is_public = true)
    )
  );

-- Writes go through embed_complete or embed_upsert_client (service_role
-- + the SECURITY DEFINER RPC respectively). No direct INSERT/UPDATE
-- from authenticated callers.

create trigger recipe_embeddings_updated
  before update on public.recipe_embeddings
  for each row execute function public.touch_updated_at();

-- ---------- recipe_embedding_jobs ----------

create table public.recipe_embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'CLAIMED', 'DONE', 'FAILED')),
  claim_token text,
  claim_expires_at timestamptz not null default 'epoch'::timestamptz,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Coalesce repeat enqueues for the same recipe — triggers will hit
-- this on every ingredient edit; we don't need N pending rows piling
-- up. Once a row goes DONE it's no longer in the partial set, so a
-- later edit re-inserts cleanly.
create unique index recipe_embedding_jobs_one_pending
  on public.recipe_embedding_jobs(recipe_id)
  where status in ('PENDING', 'CLAIMED');

create index recipe_embedding_jobs_claim_scan_idx
  on public.recipe_embedding_jobs(status, claim_expires_at);
create index recipe_embedding_jobs_owner_status_idx
  on public.recipe_embedding_jobs(owner_id, status);

alter table public.recipe_embedding_jobs enable row level security;

create policy "recipe_embedding_jobs_read_own" on public.recipe_embedding_jobs
  for select using (owner_id = auth.uid());

create trigger recipe_embedding_jobs_updated
  before update on public.recipe_embedding_jobs
  for each row execute function public.touch_updated_at();

-- ---------- enqueue_recipe_embed_job (helper) ----------
--
-- Inserts a PENDING job for the recipe. The partial unique index
-- collapses repeat enqueues, so this is safe to call from every recipe
-- and ingredient trigger without flooding the queue.

create or replace function public.enqueue_recipe_embed_job(p_recipe_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_deleted boolean;
begin
  select c.owner_id, r.deleted
    into v_owner, v_deleted
    from public.recipes r
    join public.recipe_collections c on c.id = r.collection_id
    where r.id = p_recipe_id;
  if v_owner is null or v_deleted then
    return;
  end if;

  insert into public.recipe_embedding_jobs (owner_id, recipe_id)
    values (v_owner, p_recipe_id)
    on conflict (recipe_id) where status in ('PENDING', 'CLAIMED') do nothing;
end;
$$;

revoke all on function public.enqueue_recipe_embed_job(uuid) from public, anon;
grant execute on function public.enqueue_recipe_embed_job(uuid) to authenticated, service_role;

-- ---------- Triggers: recipes + ingredients ----------

create or replace function public.recipes_enqueue_embed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform public.enqueue_recipe_embed_job(NEW.id);
  elsif TG_OP = 'UPDATE' then
    -- Skip if nothing the embed text cares about changed. The text
    -- helper consumes title/description/notes/book_title/equipment
    -- from this table.
    if NEW.deleted then return NEW; end if;
    if NEW.title is distinct from OLD.title
       or NEW.description is distinct from OLD.description
       or NEW.notes is distinct from OLD.notes
       or NEW.book_title is distinct from OLD.book_title
       or NEW.equipment is distinct from OLD.equipment then
      perform public.enqueue_recipe_embed_job(NEW.id);
    end if;
  end if;
  return NEW;
end;
$$;

create trigger recipes_enqueue_embed_aiu
  after insert or update on public.recipes
  for each row execute function public.recipes_enqueue_embed();

create or replace function public.ingredients_enqueue_embed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipe uuid;
begin
  if TG_OP = 'DELETE' then
    v_recipe := OLD.recipe_id;
  else
    v_recipe := NEW.recipe_id;
  end if;
  perform public.enqueue_recipe_embed_job(v_recipe);
  return null;
end;
$$;

create trigger ingredients_enqueue_embed_aiud
  after insert or update or delete on public.ingredients
  for each row execute function public.ingredients_enqueue_embed();

-- ---------- embed_claim_next ----------

create or replace function public.embed_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 16
) returns setof public.recipe_embedding_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Reclaim expired leases first.
  update public.recipe_embedding_jobs
    set status = 'PENDING', claim_token = null
    where status = 'CLAIMED' and claim_expires_at < now();

  return query
    update public.recipe_embedding_jobs
      set status = 'CLAIMED',
          claim_token = p_worker_id,
          claim_expires_at = now() + make_interval(secs => p_lease_seconds),
          attempts = attempts + 1,
          updated_at = now()
      where id in (
        select id from public.recipe_embedding_jobs
          where status = 'PENDING'
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;

revoke all on function public.embed_claim_next(text, int, int) from public, authenticated, anon;
grant execute on function public.embed_claim_next(text, int, int) to service_role;

-- ---------- embed_complete ----------
--
-- Atomically upserts the vector + hash and marks the job DONE. Vectors
-- are sent in as float[] (PostgREST friendly) and cast to vector(384)
-- inside the function so the wire format stays simple.

create or replace function public.embed_complete(
  p_job_id uuid,
  p_claim_token text,
  p_text_hash text,
  p_embedding real[],
  p_model text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipe uuid;
begin
  select recipe_id into v_recipe
    from public.recipe_embedding_jobs
    where id = p_job_id and claim_token = p_claim_token;
  if v_recipe is null then
    return false;
  end if;
  if array_length(p_embedding, 1) <> 384 then
    raise exception 'embed_complete: expected 384-dim vector, got %', array_length(p_embedding, 1);
  end if;

  insert into public.recipe_embeddings (recipe_id, embedding, text_hash, model)
    values (v_recipe, p_embedding::vector(384), p_text_hash, p_model)
    on conflict (recipe_id) do update set
      embedding = excluded.embedding,
      text_hash = excluded.text_hash,
      model = excluded.model,
      embedded_at = now(),
      updated_at = now();

  update public.recipe_embedding_jobs set
    status = 'DONE',
    last_error = null,
    claim_token = null,
    updated_at = now()
    where id = p_job_id;

  return true;
end;
$$;

revoke all on function public.embed_complete(uuid, text, text, real[], text) from public, authenticated, anon;
grant execute on function public.embed_complete(uuid, text, text, real[], text) to service_role;

-- ---------- embed_fail ----------

create or replace function public.embed_fail(
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
  update public.recipe_embedding_jobs set
    status = p_next_state,
    last_error = p_error,
    claim_token = null,
    updated_at = now()
    where id = p_job_id and claim_token = p_claim_token;
  return found;
end;
$$;

revoke all on function public.embed_fail(uuid, text, text, text) from public, authenticated, anon;
grant execute on function public.embed_fail(uuid, text, text, text) to service_role;

-- ---------- embed_upsert_client ----------
--
-- Lets an authenticated caller (the browser, on recipe save) push a
-- locally-computed vector to short-circuit the worker. Ownership-
-- checked through the recipe → collection join; the matching pending
-- job (if any) is marked DONE so the worker doesn't redo the work.
--
-- Dimension validation lives here so a malformed client can't poison
-- the table.

create or replace function public.embed_upsert_client(
  p_recipe_id uuid,
  p_text_hash text,
  p_embedding real[],
  p_model text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  v_owner uuid;
begin
  if caller is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if array_length(p_embedding, 1) <> 384 then
    raise exception 'embed_upsert_client: expected 384-dim vector, got %', array_length(p_embedding, 1);
  end if;

  select c.owner_id into v_owner
    from public.recipes r
    join public.recipe_collections c on c.id = r.collection_id
    where r.id = p_recipe_id;
  if v_owner is null then
    raise exception 'Recipe not found' using errcode = '42501';
  end if;
  if v_owner <> caller then
    raise exception 'Recipe not owned by caller' using errcode = '42501';
  end if;

  insert into public.recipe_embeddings (recipe_id, embedding, text_hash, model)
    values (p_recipe_id, p_embedding::vector(384), p_text_hash, p_model)
    on conflict (recipe_id) do update set
      embedding = excluded.embedding,
      text_hash = excluded.text_hash,
      model = excluded.model,
      embedded_at = now(),
      updated_at = now();

  -- Mark any in-flight job for this recipe DONE so the worker can skip it.
  update public.recipe_embedding_jobs
    set status = 'DONE',
        claim_token = null,
        last_error = null,
        updated_at = now()
    where recipe_id = p_recipe_id
      and status in ('PENDING', 'CLAIMED');

  return true;
end;
$$;

revoke all on function public.embed_upsert_client(uuid, text, real[], text) from public, anon;
grant execute on function public.embed_upsert_client(uuid, text, real[], text) to authenticated;

-- ---------- embed_kick ----------
--
-- Mirrors ocr_kick + rewrite_kick. Reuses the import_worker_config
-- vault secret because there's only one Edge Function (import-worker)
-- carrying every drain loop.

create or replace function public.embed_kick()
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
    body := jsonb_build_object('embed', true)
  );
end;
$$;

revoke all on function public.embed_kick() from public;
grant execute on function public.embed_kick() to authenticated;

-- ---------- pg_cron tick ----------

do $$ begin
  perform cron.schedule(
    'embed-worker-tick',
    '30 seconds',
    $cron$
      do $cronbody$
      begin
        perform public.embed_kick();
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

-- ---------- Realtime publication ----------
--
-- Stream both tables so live devices see the cache fill as the worker
-- drains the queue, and so clients can show progress.

alter publication supabase_realtime add table public.recipe_embeddings;
alter publication supabase_realtime add table public.recipe_embedding_jobs;

-- ---------- One-time backfill ----------
--
-- Enqueue every existing recipe. The unique partial index keeps repeat
-- migration runs idempotent.

insert into public.recipe_embedding_jobs (owner_id, recipe_id)
  select c.owner_id, r.id
    from public.recipes r
    join public.recipe_collections c on c.id = r.collection_id
    where r.deleted = false
    on conflict (recipe_id) where status in ('PENDING', 'CLAIMED') do nothing;
