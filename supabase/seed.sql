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

-- Children are stored inline as JSON on the recipe row (2026-07-08). The keys
-- are the StoredIngredient / StoredInstruction contract (packages/db/src/recipeJson.ts).
insert into public.recipes (
  id, collection_id, title, servings_amount, servings_description, sort_order,
  has_content, ingredients, instructions
)
values (
  '33333333-3333-3333-3333-333333333333',
  '22222222-2222-2222-2222-222222222222',
  'Chocolate Chip Cookies',
  24, 'cookies', 0,
  true,
  jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'type', 'MEASURED', 'name', 'all-purpose flour',
      'quantity', jsonb_build_object('type', 'EXACT', 'amount', 2.25, 'unit', 'cup')),
    jsonb_build_object('id', gen_random_uuid(), 'type', 'MEASURED', 'name', 'baking soda',
      'quantity', jsonb_build_object('type', 'EXACT', 'amount', 1, 'unit', 'teaspoon')),
    jsonb_build_object('id', gen_random_uuid(), 'type', 'MEASURED', 'name', 'butter',
      'quantity', jsonb_build_object('type', 'EXACT', 'amount', 1, 'unit', 'cup')),
    jsonb_build_object('id', gen_random_uuid(), 'type', 'MEASURED', 'name', 'brown sugar',
      'quantity', jsonb_build_object('type', 'EXACT', 'amount', 0.75, 'unit', 'cup')),
    jsonb_build_object('id', gen_random_uuid(), 'type', 'MEASURED', 'name', 'granulated sugar',
      'quantity', jsonb_build_object('type', 'EXACT', 'amount', 0.75, 'unit', 'cup')),
    jsonb_build_object('id', gen_random_uuid(), 'type', 'MEASURED', 'name', 'eggs',
      'quantity', jsonb_build_object('type', 'EXACT', 'amount', 2, 'unit', 'piece')),
    jsonb_build_object('id', gen_random_uuid(), 'type', 'MEASURED', 'name', 'vanilla extract',
      'quantity', jsonb_build_object('type', 'EXACT', 'amount', 1, 'unit', 'teaspoon')),
    jsonb_build_object('id', gen_random_uuid(), 'type', 'MEASURED', 'name', 'chocolate chips',
      'quantity', jsonb_build_object('type', 'EXACT', 'amount', 2, 'unit', 'cup')),
    jsonb_build_object('id', gen_random_uuid(), 'type', 'VAGUE', 'name', 'salt')
  ),
  jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'stepNumber', 1, 'text', 'Preheat oven to 375°F.'),
    jsonb_build_object('id', gen_random_uuid(), 'stepNumber', 2, 'text', 'Cream butter and sugars until light.'),
    jsonb_build_object('id', gen_random_uuid(), 'stepNumber', 3, 'text', 'Beat in eggs and vanilla.'),
    jsonb_build_object('id', gen_random_uuid(), 'stepNumber', 4, 'text', 'Stir in flour, baking soda, and salt.'),
    jsonb_build_object('id', gen_random_uuid(), 'stepNumber', 5, 'text', 'Fold in chocolate chips.'),
    jsonb_build_object('id', gen_random_uuid(), 'stepNumber', 6, 'text', 'Drop rounded tablespoons onto ungreased baking sheets.'),
    jsonb_build_object('id', gen_random_uuid(), 'stepNumber', 7, 'text', 'Bake 9 to 11 minutes until golden brown.')
  )
)
on conflict (id) do nothing;
