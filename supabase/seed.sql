-- Seed data for local development.
-- Creates a demo user, profile, and a sample personal collection with one recipe.

-- Insert a demo user directly into auth.users (only works against local dev).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated', 'authenticated',
  'demo@cookyourbooks.local',
  crypt('demo1234', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Demo Cook"}',
  now(), now(),
  '', '', '', ''
) on conflict (id) do nothing;

-- The auth trigger creates the profile; if running before the trigger is
-- installed, insert defensively.
insert into public.profiles (id, display_name)
values ('11111111-1111-1111-1111-111111111111', 'Demo Cook')
on conflict (id) do nothing;

-- Promote the demo user to admin so the moderation UI is reachable on a
-- fresh local stack. In production this bootstrap happens manually via
-- direct DB insert or by granting to an existing admin.
insert into public.admins (user_id, note)
values ('11111111-1111-1111-1111-111111111111', 'seeded by supabase/seed.sql')
on conflict (user_id) do nothing;

-- Sample collection + recipe.
insert into public.recipe_collections (id, owner_id, title, source_type, description, is_public)
values (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'Favorites',
  'PERSONAL',
  'Recipes I keep coming back to.',
  true
)
on conflict (id) do nothing;

insert into public.recipes (id, collection_id, title, servings_amount, servings_description, sort_order)
values (
  '33333333-3333-3333-3333-333333333333',
  '22222222-2222-2222-2222-222222222222',
  'Chocolate Chip Cookies',
  24, 'cookies', 0
)
on conflict (id) do nothing;

insert into public.ingredients (recipe_id, sort_order, type, name, quantity_type, quantity_amount, quantity_unit)
values
  ('33333333-3333-3333-3333-333333333333', 0, 'MEASURED', 'all-purpose flour', 'EXACT', 2.25, 'cup'),
  ('33333333-3333-3333-3333-333333333333', 1, 'MEASURED', 'baking soda', 'EXACT', 1, 'teaspoon'),
  ('33333333-3333-3333-3333-333333333333', 2, 'MEASURED', 'butter', 'EXACT', 1, 'cup'),
  ('33333333-3333-3333-3333-333333333333', 3, 'MEASURED', 'brown sugar', 'EXACT', 0.75, 'cup'),
  ('33333333-3333-3333-3333-333333333333', 4, 'MEASURED', 'granulated sugar', 'EXACT', 0.75, 'cup'),
  ('33333333-3333-3333-3333-333333333333', 5, 'MEASURED', 'eggs', 'EXACT', 2, 'piece'),
  ('33333333-3333-3333-3333-333333333333', 6, 'MEASURED', 'vanilla extract', 'EXACT', 1, 'teaspoon'),
  ('33333333-3333-3333-3333-333333333333', 7, 'MEASURED', 'chocolate chips', 'EXACT', 2, 'cup')
on conflict do nothing;

insert into public.ingredients (recipe_id, sort_order, type, name)
values ('33333333-3333-3333-3333-333333333333', 8, 'VAGUE', 'salt')
on conflict do nothing;

insert into public.instructions (recipe_id, step_number, text) values
  ('33333333-3333-3333-3333-333333333333', 1, 'Preheat oven to 375°F.'),
  ('33333333-3333-3333-3333-333333333333', 2, 'Cream butter and sugars until light.'),
  ('33333333-3333-3333-3333-333333333333', 3, 'Beat in eggs and vanilla.'),
  ('33333333-3333-3333-3333-333333333333', 4, 'Stir in flour, baking soda, and salt.'),
  ('33333333-3333-3333-3333-333333333333', 5, 'Fold in chocolate chips.'),
  ('33333333-3333-3333-3333-333333333333', 6, 'Drop rounded tablespoons onto ungreased baking sheets.'),
  ('33333333-3333-3333-3333-333333333333', 7, 'Bake 9 to 11 minutes until golden brown.')
on conflict do nothing;
