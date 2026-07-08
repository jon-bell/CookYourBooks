-- Auto-file prose pages caught under the RECIPE prompt.
--
-- The recipe prompt now asks the model to return an empty "recipes": [] plus a
-- top-level "note" when a page is entirely prose (foreword, chapter intro,
-- technique essay). The worker files that note through import_complete_notes —
-- the same RPC a user-marked NOTES page uses — even though the page was
-- captured as RECIPE. For the board to classify + render it as a note (rather
-- than an empty recipe stuck in "Needs review"), import_complete_notes now also
-- stamps kind = 'NOTES' on the item. This is a no-op for a page already marked
-- NOTES, so the genuine-notes path is unchanged. Status stays OCR_DONE (via
-- import_complete); the board drops NOTES-kind items from its review bucket.
--
-- Redefined verbatim from 20260625000100 + the kind stamp.

create or replace function public.import_complete_notes(
  p_item_id uuid,
  p_claim_token text,
  p_attempt jsonb,
  p_title text,
  p_body text,
  p_source_text text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_batch uuid;
  v_assigned uuid;
  v_collection uuid;
  v_done boolean;
begin
  select owner_id, batch_id, assigned_collection_id
    into v_owner, v_batch, v_assigned
    from public.import_items
   where id = p_item_id and claim_token = p_claim_token;
  if v_owner is null then
    return false;  -- lease lost / not found
  end if;

  v_collection := coalesce(
    v_assigned,
    (select target_collection_id from public.import_batches where id = v_batch)
  );

  insert into public.collection_notes
    (collection_id, owner_id, import_item_id, title, body, source_image_text, sort_order)
  values (
    v_collection, v_owner, p_item_id,
    coalesce(nullif(btrim(p_title), ''), 'Note'),
    coalesce(p_body, ''),
    p_source_text,
    coalesce(
      (select max(sort_order) + 1 from public.collection_notes
        where collection_id is not distinct from v_collection),
      0
    )
  )
  on conflict (import_item_id) where import_item_id is not null
  do update set
    collection_id = excluded.collection_id,
    title = excluded.title,
    body = excluded.body,
    source_image_text = excluded.source_image_text,
    updated_at = now();

  v_done := public.import_complete(p_item_id, p_claim_token, p_attempt, '[]'::jsonb);

  -- A page we filed as a note IS a notes page even if it was captured as RECIPE
  -- (auto-detected prose). Flip kind so the board buckets it under Notes and the
  -- item page renders the filed note instead of an empty recipe draft. The
  -- import_items_sync_kind trigger keeps is_toc consistent.
  if v_done then
    update public.import_items
       set kind = 'NOTES'
     where id = p_item_id and kind <> 'NOTES';
  end if;

  return v_done;
end;
$$;
revoke all on function public.import_complete_notes(uuid, text, jsonb, text, text, text)
  from public, authenticated, anon;
grant execute on function public.import_complete_notes(uuid, text, jsonb, text, text, text)
  to service_role;
