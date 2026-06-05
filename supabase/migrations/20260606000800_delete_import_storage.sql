-- OCR image deletion.
--
-- Users can wipe the source images they uploaded for OCR while keeping
-- the structured recipe data that came back. Privacy-motivated (the
-- uploaded photo could be a hand-written family-recipe card or a
-- copyrighted cookbook page); the OCR'd draft + any promoted recipes
-- are independent of the source image and survive.
--
-- Three scopes, all served by the same RPC:
--   - 'item' : a single import_items row (p_id is the item id)
--   - 'batch': every item in an import_batches row (p_id is the batch id)
--   - 'all'  : every import_item the caller owns (p_id ignored)
--
-- Architecture: this RPC returns the list of paths it cleared on the
-- DB side. The client then calls `supabase.storage.from('imports')
-- .remove(paths)` to delete the actual bucket objects. The bucket
-- DELETE policy is already gated to the caller's own folder via the
-- existing `imports_delete_own` policy (see 20260522000000_imports.sql),
-- so a security-definer storage delete from inside this RPC would
-- duplicate that gating; cleaner to do the storage call from the
-- client where the bucket SDK already knows about it.

create or replace function public.clear_my_import_storage(
  p_scope text,
  p_id uuid default null
) returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_paths text[] := array[]::text[];
  v_cleared int := 0;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_scope not in ('item', 'batch', 'all') then
    raise exception 'Invalid scope: % (expected item|batch|all)', p_scope using errcode = 'P0001';
  end if;
  if p_scope in ('item', 'batch') and p_id is null then
    raise exception 'Scope % requires p_id', p_scope using errcode = 'P0001';
  end if;

  -- Collect every storage path the user owns within the requested
  -- scope. nullif filters out the empty-string sentinel that lives on
  -- newly-created rows that haven't been uploaded yet.
  with paths as (
    select unnest(
      array_remove(
        array_remove(
          array_cat(
            array[
              nullif(i.storage_path, ''),
              nullif(i.thumb_path, ''),
              nullif(i.source_pdf_path, '')
            ],
            i.extra_storage_paths
          ),
          null
        ),
        ''
      )
    ) as path
    from public.import_items i
    where i.owner_id = v_user
      and (
        (p_scope = 'item'  and i.id = p_id)
     or (p_scope = 'batch' and i.batch_id = p_id)
     or (p_scope = 'all')
      )
  )
  select coalesce(array_agg(distinct path), array[]::text[])
    into v_paths
    from paths
    where path is not null;

  -- Clear the path columns on the affected rows. Doing it in one
  -- update per scope keeps the trigger churn small.
  update public.import_items
     set storage_path = '',
         thumb_path = null,
         source_pdf_path = null,
         extra_storage_paths = '{}'::text[]
   where owner_id = v_user
     and (
       (p_scope = 'item'  and id = p_id)
    or (p_scope = 'batch' and batch_id = p_id)
    or (p_scope = 'all')
     );
  get diagnostics v_cleared = row_count;

  -- Audit row so the deletion is traceable (privacy-policy parity with
  -- account deletion and the household actions).
  perform public.record_audit(
    'OCR_STORAGE_DELETED', 'IMPORT_BATCH',
    case when p_scope = 'batch' then p_id else null end,
    null,
    jsonb_build_object(
      'scope', p_scope,
      'target_id', p_id,
      'items_cleared', v_cleared,
      'path_count', coalesce(array_length(v_paths, 1), 0)
    )
  );

  return v_paths;
end;
$$;

grant execute on function public.clear_my_import_storage(text, uuid) to authenticated;
