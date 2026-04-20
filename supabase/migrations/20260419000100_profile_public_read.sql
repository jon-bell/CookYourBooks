-- Profiles that own at least one public collection need to be readable so
-- the public_collections view (security_invoker) can join against them
-- when queried as anon. Exposing display_name/avatar_url is expected for
-- any social/discovery surface.
create policy "profiles_public_read" on public.profiles
  for select using (true);
