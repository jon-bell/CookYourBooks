-- Capture-time page kind + OCR'd "general notes".
--
-- Two related features land together:
--
-- 1. import_items.kind ('RECIPE' | 'TOC' | 'NOTES') — a single discriminator
--    the worker switches on to pick its prompt. `is_toc` is kept as a derived
--    mirror for one release (a BEFORE trigger keeps the pair consistent no
--    matter which one a writer sets), so the legacy is_toc readers + the
--    import_set_item_toc RPC keep working until everything moves to `kind`.
--
-- 2. collection_notes — prose pages (forewords, chapter intros, technique
--    essays) OCR'd as text and stored as first-class, household-shareable
--    notes attached to a cookbook. Mirrors recipe_tags exactly for sharing:
--    denormalized owner_id + household_id, claim-based INLINED RLS
--    (own OR'd first; household branch leads with owner_id <> auth.uid()),
--    set_owned_row_household write-time trigger, and inclusion in
--    refresh_household_denorm. The worker auto-files a note via
--    import_complete_notes (the user chose auto-save); collection_id is
--    nullable so an unassigned-batch note is still persisted (and filed later)
--    rather than lost.

-- ============================================================
-- 1. import_items.kind
-- ============================================================
alter table public.import_items
  add column if not exists kind text not null default 'RECIPE';
alter table public.import_items
  drop constraint if exists import_items_kind_check;
alter table public.import_items
  add constraint import_items_kind_check check (kind in ('RECIPE', 'TOC', 'NOTES'));

-- Backfill from the existing boolean (bumps updated_at via import_items_updated
-- so clients pull the corrected kind on their next incremental sync).
update public.import_items set kind = 'TOC' where is_toc and kind <> 'TOC';

-- Keep kind <-> is_toc consistent for any writer that sets only one of them
-- (e.g. the legacy import_set_item_toc RPC sets is_toc but not kind). On a
-- write that changes one, derive the other.
create or replace function public.import_items_sync_kind()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.kind = 'TOC' then
      new.is_toc := true;
    elsif new.kind = 'NOTES' then
      new.is_toc := false;
    elsif new.is_toc then
      -- kind defaulted to RECIPE but a legacy writer set is_toc.
      new.kind := 'TOC';
    end if;
  else
    if new.kind is distinct from old.kind then
      new.is_toc := (new.kind = 'TOC');
    elsif new.is_toc is distinct from old.is_toc then
      new.kind := case when new.is_toc then 'TOC' else 'RECIPE' end;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists import_items_sync_kind on public.import_items;
create trigger import_items_sync_kind
  before insert or update on public.import_items
  for each row execute function public.import_items_sync_kind();

-- ============================================================
-- 2. import_set_item_kind — owner-callable re-tag + re-OCR (clones
--    import_set_item_toc). Status->PENDING can't go through the client push
--    scrub, so it must be server-side. Clears prior OCR side-effects (ToC
--    lines AND any note filed from this page) so a re-OCR doesn't duplicate.
-- ============================================================
create or replace function public.import_set_item_kind(
  p_item_id uuid,
  p_kind text
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
  if p_kind is null or p_kind not in ('RECIPE', 'TOC', 'NOTES') then
    raise exception 'p_kind must be RECIPE, TOC, or NOTES' using errcode = '22023';
  end if;

  select owner_id into owner
    from public.import_items
   where id = p_item_id;
  if owner is null or owner <> caller then
    raise exception 'Item not found or not owned by caller' using errcode = '42501';
  end if;

  delete from public.import_toc_entries where item_id = p_item_id;
  delete from public.collection_notes where import_item_id = p_item_id;

  update public.import_items
     set kind = p_kind,
         is_toc = (p_kind = 'TOC'),
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
revoke all on function public.import_set_item_kind(uuid, text) from public;
grant execute on function public.import_set_item_kind(uuid, text) to authenticated;

-- ============================================================
-- 3. collection_notes table
-- ============================================================
create table public.collection_notes (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: a note OCR'd from an unassigned batch is still persisted, then
  -- filed to a cookbook later. on delete cascade only bites for non-null.
  collection_id uuid references public.recipe_collections(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  household_id uuid,                       -- denormalized; trigger + refresh maintain it
  import_item_id uuid references public.import_items(id) on delete set null,
  title text not null default '',
  body text not null default '',
  source_image_text text,
  page_numbers int[] not null default '{}',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One note per source page so a re-OCR upserts in place (partial: manual
-- notes carry no import_item_id and are unconstrained).
create unique index collection_notes_item_uidx
  on public.collection_notes(import_item_id) where import_item_id is not null;
create index collection_notes_collection_idx on public.collection_notes(collection_id, sort_order);
create index collection_notes_owner_updated_idx on public.collection_notes(owner_id, updated_at);
create index collection_notes_household_idx
  on public.collection_notes(household_id) where household_id is not null;

alter table public.collection_notes enable row level security;

-- READ: own OR household (claim-based, INLINED, own OR'd first; household
-- branch leads with owner_id <> auth.uid() to keep Realtime delivery working).
-- Copied char-for-char from recipe_tags_read (20260623000200).
create policy "collection_notes_read" on public.collection_notes
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );
create policy "collection_notes_insert_own" on public.collection_notes
  for insert with check (owner_id = (select auth.uid()));
create policy "collection_notes_update_own" on public.collection_notes
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "collection_notes_delete_own" on public.collection_notes
  for delete using (owner_id = (select auth.uid()));

create trigger collection_notes_updated
  before update on public.collection_notes
  for each row execute function public.touch_updated_at();

-- Stamp household_id from the owner's active sharing household on write
-- (same generic trigger fn recipe_tags / cooking_events use).
drop trigger if exists collection_notes_set_household on public.collection_notes;
create trigger collection_notes_set_household
  before insert or update of owner_id on public.collection_notes
  for each row execute function public.set_owned_row_household();

alter publication supabase_realtime add table public.collection_notes;

-- ============================================================
-- 4. import_complete_notes — worker auto-file (service-role). Upserts the
--    note keyed on the source page, then reuses import_complete for the
--    attempt log + status flip (empty recipe drafts).
-- ============================================================
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

  return public.import_complete(p_item_id, p_claim_token, p_attempt, '[]'::jsonb);
end;
$$;
revoke all on function public.import_complete_notes(uuid, text, jsonb, text, text, text)
  from public, authenticated, anon;
grant execute on function public.import_complete_notes(uuid, text, jsonb, text, text, text)
  to service_role;

-- ============================================================
-- 5. refresh_household_denorm — add collection_notes to the bulk transition
--    update (otherwise notes written before a sharing toggle never share).
--    Redefined verbatim from 20260623000100 + the collection_notes line.
-- ============================================================
create or replace function public.refresh_household_denorm(p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_hh uuid;
begin
  set local statement_timeout = '120s';
  v_hh := public.owner_shared_household(p_owner);
  update public.recipe_collections          set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipes                      set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.ingredients                  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.instructions                 set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.instruction_ingredient_refs  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.cooking_events               set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipe_tags                  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.collection_notes             set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
end;
$$;
revoke all on function public.refresh_household_denorm(uuid) from public, anon, authenticated;

analyze public.collection_notes;
analyze public.import_items;
