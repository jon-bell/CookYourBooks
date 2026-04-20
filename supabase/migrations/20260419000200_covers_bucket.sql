-- Covers bucket: public-readable images for collection covers and recipe
-- photos. Users can upload only into a path that begins with their own
-- user id (storage.foldername()[1] = auth.uid()).

insert into storage.buckets (id, name, public)
values ('covers', 'covers', true)
on conflict (id) do nothing;

create policy "covers_read_all" on storage.objects
  for select
  using (bucket_id = 'covers');

create policy "covers_write_own" on storage.objects
  for insert
  with check (
    bucket_id = 'covers'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "covers_update_own" on storage.objects
  for update
  using (
    bucket_id = 'covers'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "covers_delete_own" on storage.objects
  for delete
  using (
    bucket_id = 'covers'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );
