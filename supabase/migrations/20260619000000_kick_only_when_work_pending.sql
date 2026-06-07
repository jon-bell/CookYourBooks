-- Stop the cron from waking the OCR worker on an idle system.
--
-- WHY: `ocr_kick(null)` and `rewrite_kick(null)` are each on a 30s pg_cron.
-- Their only guard is an *ownership* check that runs solely when a specific
-- id is passed (user-initiated kicks). The cron passes NULL, so it falls
-- straight through to an unconditional `net.http_post` to the import-worker
-- — every 30s, forever, even with zero queued work. Each invocation then
-- spins up all four drain loops (import + bakeoff + rewrite + import-variant),
-- firing ~5 claim/HEAD RPCs apiece. Two crons => ~10 pointless RPCs every 30s
-- on a 512MB / fractional-CPU instance (this is the bulk of the ~19k
-- import_claim_next calls seen in pg_stat_statements) and constant
-- contention behind the 57014 statement timeouts.
--
-- FIX: a cheap `worker_has_pending_work()` probe (indexed status lookups),
-- checked on the NULL-id (cron / global sweep) path of both kicks. Idle =>
-- silent no-op, so the worker simply doesn't run when there's nothing to do.
-- Busy is unchanged: any claimable row in any queue still wakes it, and
-- explicit id'd kicks (a user who just uploaded / started a rewrite) always
-- fire. "Claimable" mirrors the *_claim_next RPCs: a PENDING row, or a
-- CLAIMED row whose lease has expired (those get re-armed to PENDING on
-- claim).

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
                 where status = 'CLAIMED' and claim_expires_at < now());
$$;

-- Internal helper only — called from within the SECURITY DEFINER kicks. Not
-- exposed through PostgREST.
revoke all on function public.worker_has_pending_work() from public;

create or replace function public.ocr_kick(p_batch_id uuid DEFAULT NULL::uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'vault'
as $function$
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

  -- Cron / global sweep (no specific batch): only wake the worker when
  -- there's actually claimable work. Skip the POST otherwise.
  if p_batch_id is null and not public.worker_has_pending_work() then
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
    body := jsonb_build_object('batch_id', p_batch_id)
  );
end;
$function$;

create or replace function public.rewrite_kick(p_recipe_id uuid DEFAULT NULL::uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'vault'
as $function$
declare
  cfg jsonb;
  url text;
  key text;
  caller uuid := auth.uid();
begin
  if p_recipe_id is not null and caller is not null then
    if not exists (
      select 1 from public.rewrite_jobs
        where recipe_id = p_recipe_id and owner_id = caller
    ) then
      -- Soft-skip: not having a job yet is fine (the cron tick will
      -- still drain anything pending), but kicking without one is a no-op.
      return;
    end if;
  end if;

  -- Cron / global sweep (no specific recipe): the import-worker drains every
  -- queue per invocation, so only wake it when something is claimable.
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
    body := jsonb_build_object('rewrite', true)
  );
end;
$function$;
