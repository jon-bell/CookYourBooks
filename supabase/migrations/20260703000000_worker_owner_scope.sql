-- Test-only owner scoping for the worker claim loops.
--
-- The import-worker drains EVERY pending job (OCR / embed / cover / remix /
-- bakeoff / rewrite / variants) on each invocation, across all users. That's
-- correct for prod (one worker serving everyone), but it makes the e2e
-- worker-backed specs un-parallelizable: each test synchronously pumps the
-- worker, so concurrent tests drain each other's jobs and miss the intermediate
-- states they assert.
--
-- This adds an optional `p_only_owner uuid default null` to every `*_claim_next`
-- RPC. When NULL (prod kicks, pg_cron) behaviour is identical to before. When
-- set (the e2e harness passes the test's user id), the claim is filtered to that
-- owner — so a test only ever advances ITS OWN jobs and never contends with
-- another test's queue. Default-null keeps prod a no-op.
--
-- Adding a trailing param means a drop+recreate (an overload with a defaulted
-- arg would make 3-arg calls ambiguous: "function is not unique").

-- ---------- import_claim_next ----------
drop function if exists public.import_claim_next(text, uuid, int, int);
create function public.import_claim_next(
  p_worker_id text,
  p_batch_id uuid default null,
  p_lease_seconds int default 300,
  p_limit int default 8,
  p_only_owner uuid default null
) returns setof public.import_items
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.import_items
    set status = 'PENDING', claim_token = null
    where status = 'CLAIMED' and claim_expires_at < now();

  return query
    update public.import_items
      set status = 'CLAIMED',
          claim_token = p_worker_id,
          claim_expires_at = now() + make_interval(secs => p_lease_seconds)
      where id in (
        select id from public.import_items
          where status = 'PENDING'
            and (p_batch_id is null or batch_id = p_batch_id)
            and (p_only_owner is null or owner_id = p_only_owner)
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;
revoke all on function public.import_claim_next(text, uuid, int, int, uuid) from public, authenticated, anon;
grant execute on function public.import_claim_next(text, uuid, int, int, uuid) to service_role;

-- ---------- embed_claim_next ----------
drop function if exists public.embed_claim_next(text, int, int);
create function public.embed_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 16,
  p_only_owner uuid default null
) returns setof public.recipe_embedding_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
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
            and (p_only_owner is null or owner_id = p_only_owner)
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;
revoke all on function public.embed_claim_next(text, int, int, uuid) from public, authenticated, anon;
grant execute on function public.embed_claim_next(text, int, int, uuid) to service_role;

-- ---------- cover_claim_next ----------
drop function if exists public.cover_claim_next(text, int, int);
create function public.cover_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 8,
  p_only_owner uuid default null
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
            and (p_only_owner is null or owner_id = p_only_owner)
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;
revoke all on function public.cover_claim_next(text, int, int, uuid) from public, authenticated, anon;
grant execute on function public.cover_claim_next(text, int, int, uuid) to service_role;

-- ---------- collection_cover_claim_next ----------
drop function if exists public.collection_cover_claim_next(text, int, int);
create function public.collection_cover_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 8,
  p_only_owner uuid default null
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
            and (p_only_owner is null or owner_id = p_only_owner)
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;
revoke all on function public.collection_cover_claim_next(text, int, int, uuid) from public, authenticated, anon;
grant execute on function public.collection_cover_claim_next(text, int, int, uuid) to service_role;

-- ---------- remix_claim_next ----------
drop function if exists public.remix_claim_next(text, int, int);
create function public.remix_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 4,
  p_only_owner uuid default null
) returns setof public.remix_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.remix_jobs
    set status = 'PENDING', claim_token = null
    where status = 'CLAIMED' and claim_expires_at < now();

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
            and (p_only_owner is null or owner_id = p_only_owner)
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;
revoke all on function public.remix_claim_next(text, int, int, uuid) from public, authenticated, anon;
grant execute on function public.remix_claim_next(text, int, int, uuid) to service_role;

-- ---------- bakeoff_claim_next ----------
drop function if exists public.bakeoff_claim_next(text, int, int);
create function public.bakeoff_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 4,
  p_only_owner uuid default null
) returns setof public.bakeoff_variants
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bakeoff_variants
    set status = 'PENDING', claim_token = null
    where status = 'CLAIMED' and claim_expires_at < now();

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
            and (p_only_owner is null or owner_id = p_only_owner)
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;
revoke all on function public.bakeoff_claim_next(text, int, int, uuid) from public, authenticated, anon;
grant execute on function public.bakeoff_claim_next(text, int, int, uuid) to service_role;

-- ---------- rewrite_claim_next ----------
drop function if exists public.rewrite_claim_next(text, int, int);
create function public.rewrite_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 4,
  p_only_owner uuid default null
) returns setof public.rewrite_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rewrite_jobs
    set status = 'PENDING', claim_token = null
    where status = 'CLAIMED' and claim_expires_at < now();

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
            and (p_only_owner is null or owner_id = p_only_owner)
          order by created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;
revoke all on function public.rewrite_claim_next(text, int, int, uuid) from public, authenticated, anon;
grant execute on function public.rewrite_claim_next(text, int, int, uuid) to service_role;

-- ---------- import_variant_claim_next ----------
drop function if exists public.import_variant_claim_next(text, int, int);
create function public.import_variant_claim_next(
  p_worker_id text,
  p_lease_seconds int default 300,
  p_limit int default 4,
  p_only_owner uuid default null
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
            and (p_only_owner is null or r.owner_id = p_only_owner)
          order by r.created_at asc
          limit p_limit
          for update skip locked
      )
      returning *;
end;
$$;
revoke all on function public.import_variant_claim_next(text, int, int, uuid) from public, authenticated, anon;
grant execute on function public.import_variant_claim_next(text, int, int, uuid) to service_role;
