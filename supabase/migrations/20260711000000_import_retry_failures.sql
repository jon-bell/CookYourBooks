-- Bulk OCR: one-click "re-OCR every failed page" on the batch board.
--
-- A single page can already be re-OCR'd from the item page
-- (import_reset_item), and recitation-specific casualties have a targeted
-- batch retry (import_retry_recitation_failures). This adds the blunt
-- catch-all: reset *every* OCR_FAILED item in a batch back to PENDING so
-- the worker re-reads them.
--
-- Like import_reset_item (20260706000000) it optionally re-snapshots the
-- caller's current OCR config onto the batch first, so a bulk re-OCR
-- honors the model / prompt the user has in Settings now — not the one
-- frozen at upload time. Passing no config (bare reset) leaves the batch
-- settings untouched. Returns the number of items reset so the UI can
-- report "re-OCR'ing N pages".
--
-- Owner-scoped throughout (owner_id = caller): a caller can never reset
-- another user's items, even for a shared/household batch.

create or replace function public.import_retry_failures(
  p_batch_id uuid,
  p_provider text default null,
  p_model text default null,
  p_prompt text default null,
  p_fallback_provider text default null,
  p_fallback_model text default null,
  p_key_owner_id uuid default null
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
           default_prompt = nullif(btrim(p_prompt), ''),
           fallback_provider = p_fallback_provider,
           fallback_model = p_fallback_model,
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

revoke all on function public.import_retry_failures(uuid, text, text, text, text, text, uuid) from public;
grant execute on function public.import_retry_failures(uuid, text, text, text, text, text, uuid) to authenticated;
