-- Recipe adaptations.
--
-- A user can fork one of their own recipes into a new "adaptation" —
-- same ingredients/instructions to start with, but a separate row they
-- can tweak without touching the original. `parent_recipe_id` records
-- the lineage so the UI can render a parent link on the adaptation
-- and a "children" list on the base.
--
-- `notes` is a general free-form field on every recipe (not just
-- adaptations) — e.g. "use less salt next time", "don't skip the
-- resting step". Adaptations get an extra cue from the parent link
-- but share the same field.
--
-- Adaptations are pure row inserts — no atomic fork RPC is needed
-- because we don't touch the parent. The local-first client clones
-- the recipe (new ingredient / instruction ids, refs remapped) and
-- pushes through the normal outbox path.

alter table public.recipes
  add column if not exists notes text,
  add column if not exists parent_recipe_id uuid
    references public.recipes(id) on delete set null;

-- Descendants lookup — "what did I adapt from this recipe?" is the
-- common query on the detail page.
create index if not exists recipes_parent_idx
  on public.recipes(parent_recipe_id)
  where parent_recipe_id is not null;
