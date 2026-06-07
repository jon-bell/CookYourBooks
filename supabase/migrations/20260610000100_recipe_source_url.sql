-- Per-recipe origin URL — driven by the video-import path.
--
-- When a recipe is extracted from a YouTube / TikTok / Instagram link,
-- we record the original video URL on the recipe itself. This is
-- distinct from `recipe_collections.source_url` (which is per-collection,
-- e.g. a single blog): the generic per-platform "YouTube" collection
-- holds many videos, so the individual link belongs on the recipe row.
--
-- Nullable / optional: the minimum-viable recipe (title + ingredients +
-- steps) keeps working unchanged; only the video-import flow populates it.

alter table public.recipes
  add column if not exists source_url text;
