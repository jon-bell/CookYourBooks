-- Bulk OCR: make Re-OCR re-snapshot the caller's *current* OCR config.
--
-- The worker (import-worker) resolves provider / model / prompt entirely
-- from the import_batches row — captured once at upload time. The Re-OCR
-- button called import_reset_item, which only reset the *item* and never
-- refreshed the batch. So a re-OCR always reused the upload-time model /
-- prompt and silently ignored any change the user made in Settings after
-- the batch was created ("re-OCR is not picking up my default model or
-- prompt").
--
-- Extend the reset RPC to optionally re-snapshot the parent batch's OCR
-- config in the same statement — the exact fields uploadBatch writes at
-- creation time. Passing no config (bare reset) leaves the batch settings
-- untouched, so existing recovery callers keep working.

drop function if exists public.import_reset_item(uuid);

create or replace function public.import_reset_item(
  p_item_id uuid,
  p_provider text default null,
  p_model text default null,
  p_prompt text default null,
  p_fallback_provider text default null,
  p_fallback_model text default null,
  p_key_owner_id uuid default null
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
           default_prompt = nullif(btrim(p_prompt), ''),
           fallback_provider = p_fallback_provider,
           fallback_model = p_fallback_model,
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
         needs_fallback = false,
         last_error = null,
         updated_at = now()
   where id = p_item_id;
end;
$$;

revoke all on function public.import_reset_item(uuid, text, text, text, text, text, uuid) from public;
grant execute on function public.import_reset_item(uuid, text, text, text, text, text, uuid) to authenticated;
