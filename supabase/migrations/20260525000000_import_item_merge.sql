-- Bulk OCR: support merging multiple scanned pages into a single
-- import item so the LLM can see the whole recipe at once.
--
-- Failure mode this addresses: page N contains the recipe, page N+1
-- contains a single note about that recipe — the worker parsed them
-- as two separate recipes. The user wants to fold them together and
-- re-OCR with both images attached.
--
-- Design:
--   - Add `extra_storage_paths text[]` to `import_items`. The primary
--     storage_path stays as-is; extras carry the additional pages.
--   - The worker sends ALL images to the LLM in a single call.
--   - `import_merge_items(primary, absorb_ids[])` appends the absorb
--     items' storage paths onto the primary, marks absorb items
--     DISCARDED, and resets the primary to PENDING so the worker
--     re-claims it. Caller-scoped via owner_id.

alter table public.import_items
  add column extra_storage_paths text[] not null default '{}'::text[];

-- ---------- import_merge_items ----------

create or replace function public.import_merge_items(
  p_primary_id uuid,
  p_absorb_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  primary_owner uuid;
  extras text[];
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if p_primary_id is null then
    raise exception 'p_primary_id is required' using errcode = '22023';
  end if;
  if p_absorb_ids is null or array_length(p_absorb_ids, 1) is null then
    raise exception 'p_absorb_ids must be a non-empty array' using errcode = '22023';
  end if;

  select owner_id into primary_owner
    from public.import_items
   where id = p_primary_id;
  if primary_owner is null or primary_owner <> caller then
    raise exception 'Primary item not found or not owned by caller' using errcode = '42501';
  end if;

  -- Collect storage_paths from the items being absorbed, restricted
  -- to the caller's own rows in the same batch as the primary.
  select coalesce(array_agg(s.storage_path order by s.page_index), array[]::text[])
    into extras
    from (
      select i.storage_path, i.page_index
        from public.import_items i
        join public.import_items p on p.id = p_primary_id
       where i.id = any(p_absorb_ids)
         and i.owner_id = caller
         and i.batch_id = p.batch_id
         and i.id <> p_primary_id
    ) s;

  if array_length(extras, 1) is null then
    raise exception 'No absorb-able items found in this batch' using errcode = '22023';
  end if;

  update public.import_items
     set extra_storage_paths = extra_storage_paths || extras,
         status = 'PENDING',
         parsed_drafts_json = null,
         attempts = 0,
         claim_token = null,
         claim_expires_at = 'epoch'::timestamptz,
         needs_fallback = false,
         last_error = null,
         updated_at = now()
   where id = p_primary_id;

  update public.import_items
     set status = 'DISCARDED',
         updated_at = now()
   where id = any(p_absorb_ids)
     and owner_id = caller
     and id <> p_primary_id;
end;
$$;

revoke all on function public.import_merge_items(uuid, uuid[]) from public;
grant execute on function public.import_merge_items(uuid, uuid[]) to authenticated;
