-- Bulk OCR: let owners edit a batch's fallback provider+model after
-- creation, and retry recitation-failed items against it.
--
-- Until now, fallback_provider / fallback_model were captured once on
-- the New Import form and there was no way to fix a misconfigured
-- batch from the UI. Combined with the sticky 'FAIL' recitation
-- policy, that left batches stranded with no recovery path short of
-- direct SQL.

-- ---------- import_set_batch_fallback ----------
--
-- Owner-only. Pass non-null provider+model to set, pass nulls to
-- clear. We do NOT touch recitation_policy here — that stays a
-- separate decision (import_set_recitation_policy).

create or replace function public.import_set_batch_fallback(
  p_batch_id uuid,
  p_provider text,
  p_model text
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
         fallback_model = trimmed_model
   where id = p_batch_id and owner_id = caller;

  if not found then
    raise exception 'Batch not found or not owned by caller' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.import_set_batch_fallback(uuid, text, text) from public;
grant execute on function public.import_set_batch_fallback(uuid, text, text) to authenticated;


-- ---------- import_retry_recitation_failures ----------
--
-- Owner-only. Flips the batch's recitation_policy to FALLBACK and
-- resets every OCR_FAILED item whose most recent attempt failed with
-- error_kind = 'RECITATION', forcing the worker to use the batch's
-- fallback provider on the next claim. Returns the number of items
-- reset.
--
-- Requires the batch to have a fallback provider+model already set
-- (use import_set_batch_fallback first). Items that failed for other
-- reasons (AUTH, OTHER) are left alone — those are not "stuck on
-- recitation" and shouldn't silently fall through to the fallback.

create or replace function public.import_retry_recitation_failures(
  p_batch_id uuid
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

revoke all on function public.import_retry_recitation_failures(uuid) from public;
grant execute on function public.import_retry_recitation_failures(uuid) to authenticated;
