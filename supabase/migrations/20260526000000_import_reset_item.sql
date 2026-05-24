-- Bulk OCR: owner-callable RPC to force-reset an import item.
--
-- The Re-OCR button on the review page used to flip the local row's
-- status to PENDING and enqueue an outbox push. That push gets dropped
-- by the client-side scrub (status changes from the client are only
-- permitted on REVIEWED / DISCARDED), so a force-reset never reached
-- the server. Result: items stuck in CLAIMED with an unexpired lease,
-- or items stuck in PENDING when the worker is sick, had no user-
-- accessible recovery path.
--
-- This RPC does the work on the server, in one statement, scoped to
-- the caller's own items.

create or replace function public.import_reset_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  owner uuid;
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if p_item_id is null then
    raise exception 'p_item_id is required' using errcode = '22023';
  end if;

  select owner_id into owner
    from public.import_items
   where id = p_item_id;
  if owner is null or owner <> caller then
    raise exception 'Item not found or not owned by caller' using errcode = '42501';
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

revoke all on function public.import_reset_item(uuid) from public;
grant execute on function public.import_reset_item(uuid) to authenticated;
