-- Bulk OCR: split a committed multi-page recipe back into standalone pages.
--
-- The organizer's "reorganize" mode (any already-OCR'd batch) needs the
-- inverse of import_merge_items: an item that absorbed continuation pages
-- (extra_storage_paths non-empty) can be broken apart again into one item per
-- page. The absorbed pages were marked DISCARDED by the merge with their
-- storage_path left intact — only a hard storage-delete ever clears the extras
-- (see 20260606000800_delete_import_storage.sql) — so we revive them by
-- matching storage_path against the primary's extra_storage_paths.
--
-- Behavior: revive the primary's absorbed pages to PENDING for a fresh OCR
-- pass, then reset the primary the same way AND clear its extra_storage_paths
-- so it OCRs as a single page again. Caller-scoped via owner_id, mirroring
-- import_merge_items' ownership guards (errcodes 42501 / 22023).

create or replace function public.import_split_item(
  p_primary_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  primary_owner uuid;
  primary_batch uuid;
  extras text[];
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if p_primary_id is null then
    raise exception 'p_primary_id is required' using errcode = '22023';
  end if;

  select owner_id, batch_id, extra_storage_paths
    into primary_owner, primary_batch, extras
    from public.import_items
   where id = p_primary_id;
  if primary_owner is null or primary_owner <> caller then
    raise exception 'Primary item not found or not owned by caller' using errcode = '42501';
  end if;
  if array_length(extras, 1) is null then
    raise exception 'Item has no absorbed pages to split' using errcode = '22023';
  end if;

  -- Revive the absorbed (DISCARDED) pages for a fresh OCR pass. Matched by
  -- storage_path, restricted to the caller's own rows in the primary's batch.
  update public.import_items
     set status = 'PENDING',
         parsed_drafts_json = null,
         attempts = 0,
         claim_token = null,
         claim_expires_at = 'epoch'::timestamptz,
         needs_fallback = false,
         last_error = null,
         updated_at = now()
   where owner_id = caller
     and batch_id = primary_batch
     and status = 'DISCARDED'
     and storage_path = any(extras);

  -- Reset the primary to a standalone single-page item (drops the extras).
  update public.import_items
     set status = 'PENDING',
         parsed_drafts_json = null,
         attempts = 0,
         claim_token = null,
         claim_expires_at = 'epoch'::timestamptz,
         needs_fallback = false,
         last_error = null,
         extra_storage_paths = '{}'::text[],
         updated_at = now()
   where id = p_primary_id;
end;
$$;

revoke all on function public.import_split_item(uuid) from public;
grant execute on function public.import_split_item(uuid) to authenticated;
