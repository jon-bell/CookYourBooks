-- Collapse five 30s worker crons into one guarded tick, and stop pg_cron's
-- run history from growing without bound.
--
-- WHY: at zero user traffic this project was still doing ~100 write
-- transactions a minute, forever, which is what exhausted the disk IO budget.
-- Three separate causes, all self-inflicted:
--
-- 1. FIVE pg_cron jobs on '30 seconds' (import-worker-tick, rewrite-worker-tick,
--    cover-worker-tick, embed-worker-tick, remix-worker-tick) = 14,400 job runs
--    a day. Every one of them POSTs the *same* Edge Function, which drains
--    *every* queue per invocation (see import-worker/index.ts: runLoop +
--    bakeoff + rewrite + remix + import-variant + embed + cover +
--    collection-cover, unconditionally — the `embed`/`cover`/`remix` flags in
--    the POST body are decorative). Five crons therefore buy exactly nothing
--    over one, at five times the cost.
--
-- 2. Two of the five had no pending-work guard. 20260619000000 introduced
--    `worker_has_pending_work()` and wired it into ocr_kick + rewrite_kick;
--    20260626000100 / 20260702000000 extended it to the two cover queues. But
--    `embed_kick` (20260605000100) predates the guard and never got it, and
--    `remix_kick` (20260627000000) was written after it and reintroduced the
--    pattern — it only guards the `p_recipe_id is not null` path, which the
--    cron never takes. So those two fired an unconditional net.http_post twice
--    a minute on a completely idle system: a vault decrypt, a
--    net.http_request_queue row, a net._http_response row, and an Edge
--    invocation that ran all eight *_claim_next RPCs. Each claim_next is two
--    UPDATEs in a write transaction even when it matches zero rows, so that is
--    ~32 no-op WAL-committed transactions a minute — and since the queue tables
--    are in `supabase_realtime`, each one also gets logically decoded.
--
-- 3. `cron.job_run_details` is never pruned. Supabase does not prune it for
--    you. At 14,400 runs/day that is an insert plus an update per run into a
--    table that only ever grows.
--
-- FIX: one cron, one guard, and an hourly bounded prune of the run history.

-- ---------- worker_has_pending_work: the two missing queues ----------
--
-- Already covers import_items, import_item_variant_results, bakeoff_variants,
-- rewrite_jobs, recipe_cover_jobs, collection_cover_jobs. Missing exactly the
-- two whose kicks never consulted it. Both have a (status, claim_expires_at)
-- claim-scan index, so the added EXISTS clauses stay index-only like the rest.
--
-- "Claimable" mirrors the *_claim_next RPCs: a PENDING row, or a CLAIMED row
-- whose lease has expired (those get re-armed to PENDING on claim).

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
                 where status = 'CLAIMED' and claim_expires_at < now())
    or exists (select 1 from public.recipe_embedding_jobs
                 where status = 'PENDING')
    or exists (select 1 from public.recipe_embedding_jobs
                 where status = 'CLAIMED' and claim_expires_at < now())
    or exists (select 1 from public.remix_jobs
                 where status = 'PENDING')
    or exists (select 1 from public.remix_jobs
                 where status = 'CLAIMED' and claim_expires_at < now());
$$;

revoke all on function public.worker_has_pending_work() from public;

-- ---------- worker_kick: the single canonical wake ----------
--
-- Guard + vault lookup + POST, in one place. This is what the one remaining
-- cron calls. The per-feature kicks (ocr_kick, rewrite_kick, remix_kick,
-- cover_kick) stay exactly as they are for the id'd, user-initiated path —
-- the client calls those directly right after enqueuing work and must still
-- wake the worker immediately, guard or no guard.
--
-- The POST body is irrelevant to routing (the worker drains every queue per
-- invocation); `tick` is there to make the source obvious in function logs.
-- Not exposed through PostgREST: cron is the only caller.

create or replace function public.worker_kick()
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
  if not public.worker_has_pending_work() then
    return;
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
    body := jsonb_build_object('tick', true)
  );
end;
$$;

revoke all on function public.worker_kick() from public, anon, authenticated;

-- ---------- embed_kick: add the guard it never had ----------
--
-- Takes no arguments, so it is a global sweep by definition — there is no
-- user-initiated path to exempt. Nothing in the client calls it (the browser
-- embeds locally and pushes via embed_upsert_client); the cron was its only
-- caller. Kept as a distinct function anyway so the grant surface and any
-- future direct caller don't change shape.

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
  if not public.worker_has_pending_work() then
    return;
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
    body := jsonb_build_object('embed', true)
  );
end;
$$;

revoke all on function public.embed_kick() from public;
grant execute on function public.embed_kick() to authenticated;

-- ---------- remix_kick: guard the NULL-id (sweep) path ----------
--
-- Same shape as the ocr_kick / rewrite_kick fix in 20260619000000. An id'd
-- kick (a user who just started a remix) still fires unconditionally; the
-- global sweep no longer wakes the worker on an idle queue.

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

  if p_recipe_id is null and not public.worker_has_pending_work() then
    return;
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

-- ---------- prune_cron_job_run_details ----------
--
-- Bounded on purpose. The backlog on a long-running project is large, and a
-- single unbounded DELETE on an instance that is already IO-starved is the
-- wrong way to fix an IO problem — it would lock, generate a burst of WAL, and
-- leave a pile of dead tuples for autovacuum. 20k rows an hour drains a
-- multi-hundred-thousand-row backlog over a couple of days at a rate the disk
-- can absorb, then settles into steady state (the new single tick produces
-- 2,880 rows/day, so retention costs ~20k rows total).
--
-- pg_cron jobs here are owned by `postgres`, which is what migrations run as,
-- so the delete is permitted. Defined SECURITY DEFINER so the ownership is
-- pinned to the migration role rather than whoever the cron runs as later.

create or replace function public.prune_cron_job_run_details(
  p_retain interval default interval '7 days',
  p_limit int default 20000
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from cron.job_run_details
    where ctid in (
      select ctid from cron.job_run_details
        where end_time < now() - p_retain
        limit p_limit
    );
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_cron_job_run_details(interval, int)
  from public, anon, authenticated;

-- ---------- Retire the five ticks, schedule one ----------
--
-- Each unschedule gets its own block: cron.unschedule raises if the job is
-- absent, and a fresh database (or a local `db reset` without pg_cron) has
-- none of them.

do $$
declare
  j text;
begin
  foreach j in array array[
    'import-worker-tick',
    'rewrite-worker-tick',
    'cover-worker-tick',
    'embed-worker-tick',
    'remix-worker-tick'
  ] loop
    begin
      perform cron.unschedule(j);
    exception when others then
      null;
    end;
  end loop;
exception when others then
  null;
end $$;

do $$ begin
  perform cron.schedule(
    'worker-tick',
    '30 seconds',
    $cron$
      do $cronbody$
      begin
        perform public.worker_kick();
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

do $$ begin
  perform cron.schedule(
    'prune-cron-job-run-details',
    '43 * * * *',
    $cron$ select public.prune_cron_job_run_details(); $cron$
  );
exception when others then null;
end $$;
