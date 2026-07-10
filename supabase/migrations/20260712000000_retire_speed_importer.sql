-- Speed Importer retired; recipes.starred is repurposed as the user-facing
-- "favorite" flag (heart on recipe cards / the recipe page).
--
-- Existing starred=true rows were scan-queue markers on empty ToC
-- placeholders — the planner starred a placeholder to mean "photograph this
-- page next", never "I love this recipe" — so they must not survive as
-- favorites. Clear them, bumping updated_at so the keyset pull propagates
-- the clear to every device's local cache.
--
-- Deliberately KEPT (deployed clients still name these columns in their
-- push/pull payloads; dropping them would 400 older clients' PostgREST
-- upserts until they update):
--   import_batches.is_planner, import_items.assigned_recipe_id, and their
--   indexes. They are inert — nothing server-side reads them.
--   recipes_starred_idx (partial on starred = true) now legitimately serves
--   favorites filtering.

update public.recipes
   set starred = false,
       updated_at = now()
 where starred = true;

comment on column public.recipes.starred is
  'User favorite (heart). Formerly the Speed Importer scan-queue marker.';
comment on column public.import_batches.is_planner is
  'Legacy Speed Importer flag; retained (inert) for older-client sync compatibility.';
comment on column public.import_items.assigned_recipe_id is
  'Legacy Speed Importer pre-binding; retained (inert) for older-client sync compatibility.';
