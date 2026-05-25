-- Bulk OCR: "Group then OCR" flow.
--
-- Users uploading a stack of pages where the same recipe spans
-- multiple pages would, under the original "OCR then group" flow,
-- pay for an OCR call per page and then merge the resulting drafts.
-- This migration adds the alternative path: hold items out of the
-- worker's queue until the user has grouped pages, then merge each
-- group and release the primaries into PENDING — one OCR call per
-- recipe instead of one per page.
--
-- Mechanism:
--   - New `AWAITING_GROUPING` status. The worker only ever claims
--     PENDING rows, so AWAITING_GROUPING items are naturally invisible
--     to it. No worker change required.
--   - `import_finalize_grouping(batch_id, groups jsonb)` takes a
--     jsonb array-of-arrays where each inner array is `[primary,
--     absorbed_a, absorbed_b, ...]`. Inline-merges every group, then
--     flips all primaries to PENDING in one transaction. Absorbed
--     items become DISCARDED.

alter table public.import_items
  drop constraint if exists import_items_status_check;

alter table public.import_items
  add constraint import_items_status_check
  check (status in (
    'AWAITING_GROUPING',
    'PENDING', 'CLAIMED', 'OCR_DONE', 'NEEDS_FALLBACK', 'OCR_FAILED',
    'REVIEWED', 'DISCARDED'
  ));

-- ---------- import_finalize_grouping ----------

create or replace function public.import_finalize_grouping(
  p_batch_id uuid,
  p_groups jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  batch_owner uuid;
  group_elem jsonb;
  group_ids uuid[];
  primary_id uuid;
  absorb_ids uuid[];
  extras text[];
  seen_ids uuid[] := array[]::uuid[];
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if p_batch_id is null then
    raise exception 'p_batch_id is required' using errcode = '22023';
  end if;
  if p_groups is null or jsonb_typeof(p_groups) <> 'array' then
    raise exception 'p_groups must be a jsonb array of arrays' using errcode = '22023';
  end if;

  select owner_id into batch_owner
    from public.import_batches
   where id = p_batch_id;
  if batch_owner is null or batch_owner <> caller then
    raise exception 'Batch not found or not owned by caller' using errcode = '42501';
  end if;

  -- Walk every group. Each group: first item = primary, rest = absorbed.
  -- Per group we (a) append absorbed storage_paths onto the primary,
  -- (b) mark absorbed items DISCARDED, and (c) leave the primary at
  -- AWAITING_GROUPING for the moment — a single batch update below
  -- flips every still-AWAITING primary to PENDING so the worker
  -- starts processing the whole batch atomically.
  for group_elem in select * from jsonb_array_elements(p_groups)
  loop
    if jsonb_typeof(group_elem) <> 'array' then
      raise exception 'Each group must be a jsonb array' using errcode = '22023';
    end if;
    select array_agg((value)::text::uuid)
      into group_ids
      from jsonb_array_elements_text(group_elem);
    if group_ids is null or array_length(group_ids, 1) is null then
      continue;
    end if;
    primary_id := group_ids[1];
    absorb_ids := group_ids[2:array_length(group_ids, 1)];

    -- Reject duplicates across groups — an item can't be in two
    -- recipes at once. Catch the bad payload before we mutate rows.
    if seen_ids && group_ids then
      raise exception 'Item id appears in more than one group'
        using errcode = '22023';
    end if;
    seen_ids := seen_ids || group_ids;

    if absorb_ids is not null and array_length(absorb_ids, 1) > 0 then
      select coalesce(array_agg(s.storage_path order by s.page_index), array[]::text[])
        into extras
        from (
          select i.storage_path, i.page_index
            from public.import_items i
           where i.id = any(absorb_ids)
             and i.owner_id = caller
             and i.batch_id = p_batch_id
             and i.id <> primary_id
        ) s;

      if array_length(extras, 1) is null then
        raise exception 'No absorb-able items found in group'
          using errcode = '22023';
      end if;

      update public.import_items
         set extra_storage_paths = extra_storage_paths || extras,
             updated_at = now()
       where id = primary_id
         and owner_id = caller
         and batch_id = p_batch_id;

      update public.import_items
         set status = 'DISCARDED',
             updated_at = now()
       where id = any(absorb_ids)
         and owner_id = caller
         and batch_id = p_batch_id;
    end if;
  end loop;

  -- Release every remaining AWAITING_GROUPING row in the batch
  -- (primaries and ungrouped singletons alike) so the worker picks
  -- them up. Items absorbed above are already DISCARDED and won't
  -- match this filter.
  update public.import_items
     set status = 'PENDING',
         updated_at = now()
   where batch_id = p_batch_id
     and owner_id = caller
     and status = 'AWAITING_GROUPING';
end;
$$;

revoke all on function public.import_finalize_grouping(uuid, jsonb) from public;
grant execute on function public.import_finalize_grouping(uuid, jsonb) to authenticated;
