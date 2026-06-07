-- Photos on cooking events (V2).
--
-- A cooked / planned entry can carry photos ("here's how the lasagna
-- turned out"). Paths are stored as a jsonb array on cooking_events; the
-- bytes live in a private `cooking-photos` storage bucket under the
-- owner's uid folder, mirroring the `imports` bucket convention.
--
-- Visibility follows the SAME library-sharing gate as the cooking
-- tracker itself: a co-member who can read the owner's library can also
-- read the owner's cooking photos. The storage read policy INLINES that
-- membership test (no function call) exactly like the table policies, so
-- it stays a single hoisted membership lookup rather than a per-row call.

alter table public.cooking_events
  add column photo_paths jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public)
  values ('cooking-photos', 'cooking-photos', false)
  on conflict (id) do nothing;

-- Read: the owner, or a same-household library-sharing co-member. The
-- first path segment is the owning user's uid (clients upload to
-- `<uid>/<event>/<file>`), so the membership check keys off it.
create policy "cooking_photos_read" on storage.objects
  for select using (
    bucket_id = 'cooking-photos'
    and (select auth.uid()) is not null
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (storage.foldername(name))[1] in (
        select owner_m.user_id::text
        from public.household_members owner_m
        join public.household_members viewer_m
          on viewer_m.household_id = owner_m.household_id
        where owner_m.left_at is null
          and owner_m.library_shared = true
          and viewer_m.user_id = (select auth.uid())
          and viewer_m.left_at is null
      )
    )
  );

-- Write / update / delete: owner only, scoped to their own uid folder.
create policy "cooking_photos_write_own" on storage.objects
  for insert with check (
    bucket_id = 'cooking-photos'
    and (select auth.uid()) is not null
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy "cooking_photos_update_own" on storage.objects
  for update using (
    bucket_id = 'cooking-photos'
    and (select auth.uid()) is not null
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy "cooking_photos_delete_own" on storage.objects
  for delete using (
    bucket_id = 'cooking-photos'
    and (select auth.uid()) is not null
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
