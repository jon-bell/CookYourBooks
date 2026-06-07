-- Bulk OCR: owner-callable RPC to (un)flag an import item as a Table of
-- Contents page AND reset it for a fresh OCR pass in one statement.
--
-- Why this exists separately from import_reset_item / the is_toc toggle:
--
-- The review page's "This is a Table of Contents page" checkbox flips
-- the local row's is_toc flag and parks it PENDING, then leans on the
-- outbox to push the change. But the client-side push scrub only lets
-- the client move an item into REVIEWED / DISCARDED — every other status
-- transition is the worker's call (see pushImportItem in sync.ts). So
-- when a page was *already* OCR'd as a recipe (status OCR_DONE), ticking
-- the ToC box pushed is_toc=true but the PENDING flip was dropped, the
-- worker never re-claimed it, and the page could never be re-read with
-- the table-of-contents prompt. Same trap in reverse (ToC -> recipe).
--
-- This RPC does the server-side work the client isn't trusted to do:
-- set is_toc, clear the prior OCR output, and re-arm the row to PENDING
-- so the worker picks it up and re-OCRs with the correct prompt. It also
-- clears any toc entries previously extracted for this item, since the
-- worker inserts (not upserts) toc rows and a re-run would otherwise
-- duplicate them. Promoted recipes (created_recipe_ids) are left alone —
-- they already live in the user's cookbook and aren't ours to delete.

create or replace function public.import_set_item_toc(
  p_item_id uuid,
  p_is_toc boolean
)
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
  if p_is_toc is null then
    raise exception 'p_is_toc is required' using errcode = '22023';
  end if;

  select owner_id into owner
    from public.import_items
   where id = p_item_id;
  if owner is null or owner <> caller then
    raise exception 'Item not found or not owned by caller' using errcode = '42501';
  end if;

  -- Drop any ToC lines we extracted earlier so a re-OCR doesn't stack
  -- duplicates on top of them.
  delete from public.import_toc_entries
   where item_id = p_item_id;

  update public.import_items
     set is_toc = p_is_toc,
         status = 'PENDING',
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

revoke all on function public.import_set_item_toc(uuid, boolean) from public;
grant execute on function public.import_set_item_toc(uuid, boolean) to authenticated;
