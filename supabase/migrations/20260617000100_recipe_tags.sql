-- Recipe tagging — a general organizing tool beyond the overloaded
-- `recipes.starred` flag (which is reserved for the Speed Importer queue).
--
-- A tag is a (owner, recipe, label) triple: per-user so a household
-- member's tags on a shared recipe never collide with the owner's, and so
-- tags sync per user like everything else. `label` is trimmed + lowercased
-- by the app before write; the unique constraint keeps add idempotent.
--
-- Sharing + RLS mirror cooking_events exactly: owner CRUD + an INLINED,
-- InitPlan-hoisted household read gated on library sharing, with the
-- mandatory `owner_id <> (select auth.uid())` short-circuit first. A
-- co-member sees ("Dad tagged this 'weeknight'") but cannot mutate it.

create table public.recipe_tags (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  label text not null check (length(btrim(label)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, recipe_id, label)
);

create index recipe_tags_owner_idx on public.recipe_tags(owner_id);
create index recipe_tags_recipe_idx on public.recipe_tags(recipe_id);
create index recipe_tags_owner_updated_idx on public.recipe_tags(owner_id, updated_at);

alter table public.recipe_tags enable row level security;

create policy "recipe_tags_read_own" on public.recipe_tags
  for select using (owner_id = (select auth.uid()));
create policy "recipe_tags_insert_own" on public.recipe_tags
  for insert with check (owner_id = (select auth.uid()));
create policy "recipe_tags_update_own" on public.recipe_tags
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "recipe_tags_delete_own" on public.recipe_tags
  for delete using (owner_id = (select auth.uid()));

-- Household read — INLINED (no function call), InitPlan-hoisted, short-circuit first.
create policy "recipe_tags_read_household" on public.recipe_tags
  for select using (
    owner_id <> (select auth.uid())
    and owner_id in (
      select owner_m.user_id
      from public.household_members owner_m
      join public.household_members viewer_m
        on viewer_m.household_id = owner_m.household_id
      where owner_m.left_at is null
        and owner_m.library_shared = true
        and viewer_m.user_id = (select auth.uid())
        and viewer_m.left_at is null
    )
  );

create trigger recipe_tags_updated
  before update on public.recipe_tags
  for each row execute function public.touch_updated_at();

alter publication supabase_realtime add table public.recipe_tags;
