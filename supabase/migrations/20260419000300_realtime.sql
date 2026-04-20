-- Enable Supabase Realtime for the tables the client syncs into its
-- local cr-sqlite store. Realtime respects RLS, so clients only receive
-- events for rows their policies allow them to read — i.e. their own
-- data and any public collections they're subscribed to.

alter publication supabase_realtime add table public.recipe_collections;
alter publication supabase_realtime add table public.recipes;
alter publication supabase_realtime add table public.ingredients;
alter publication supabase_realtime add table public.instructions;
