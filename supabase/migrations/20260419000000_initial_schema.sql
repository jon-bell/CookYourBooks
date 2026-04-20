-- Initial schema for CookYourBooks.
-- Defines profiles, recipe_collections, recipes, ingredients, instructions,
-- instruction_ingredient_refs, conversion_rules, the public_collections view,
-- the fork_collection RPC, and RLS policies.

-- ---------- Profiles ----------
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_self_read" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_self_upsert" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_self_update" on public.profiles
  for update using (auth.uid() = id);

-- Auto-create a profile when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Recipe collections ----------
create table public.recipe_collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  source_type text not null check (source_type in ('PUBLISHED_BOOK', 'PERSONAL', 'WEBSITE')),
  -- Cookbook
  author text,
  isbn text,
  publisher text,
  publication_year int,
  -- Personal
  description text,
  notes text,
  -- Web
  source_url text,
  date_accessed date,
  site_name text,
  -- Shared
  is_public boolean not null default false,
  forked_from uuid references public.recipe_collections(id) on delete set null,
  cover_image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index recipe_collections_owner_idx on public.recipe_collections(owner_id);
create index recipe_collections_public_idx on public.recipe_collections(is_public) where is_public;

alter table public.recipe_collections enable row level security;

create policy "collections_read_own_or_public" on public.recipe_collections
  for select using (owner_id = auth.uid() or is_public);
create policy "collections_insert_own" on public.recipe_collections
  for insert with check (owner_id = auth.uid());
create policy "collections_update_own" on public.recipe_collections
  for update using (owner_id = auth.uid());
create policy "collections_delete_own" on public.recipe_collections
  for delete using (owner_id = auth.uid());

-- ---------- Recipes ----------
create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.recipe_collections(id) on delete cascade,
  title text not null,
  servings_amount numeric,
  servings_description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index recipes_collection_idx on public.recipes(collection_id);

alter table public.recipes enable row level security;

create policy "recipes_read_via_collection" on public.recipes
  for select using (
    exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id
        and (c.owner_id = auth.uid() or c.is_public)
    )
  );
create policy "recipes_write_via_collection" on public.recipes
  for all using (
    exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id and c.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id and c.owner_id = auth.uid()
    )
  );

-- ---------- Ingredients ----------
create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  sort_order int not null,
  type text not null check (type in ('MEASURED', 'VAGUE')),
  name text not null,
  preparation text,
  notes text,
  quantity_type text check (quantity_type in ('EXACT', 'FRACTIONAL', 'RANGE')),
  quantity_amount numeric,
  quantity_whole int,
  quantity_numerator int,
  quantity_denominator int,
  quantity_min numeric,
  quantity_max numeric,
  quantity_unit text
);

create index ingredients_recipe_idx on public.ingredients(recipe_id);

alter table public.ingredients enable row level security;

create policy "ingredients_read_via_recipe" on public.ingredients
  for select using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id
        and (c.owner_id = auth.uid() or c.is_public)
    )
  );
create policy "ingredients_write_via_recipe" on public.ingredients
  for all using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id and c.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id and c.owner_id = auth.uid()
    )
  );

-- ---------- Instructions ----------
create table public.instructions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  step_number int not null,
  text text not null
);

create index instructions_recipe_idx on public.instructions(recipe_id);

alter table public.instructions enable row level security;

create policy "instructions_read_via_recipe" on public.instructions
  for select using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id
        and (c.owner_id = auth.uid() or c.is_public)
    )
  );
create policy "instructions_write_via_recipe" on public.instructions
  for all using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id and c.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id and c.owner_id = auth.uid()
    )
  );

-- ---------- Instruction → Ingredient refs ----------
create table public.instruction_ingredient_refs (
  instruction_id uuid not null references public.instructions(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete cascade,
  primary key (instruction_id, ingredient_id)
);

alter table public.instruction_ingredient_refs enable row level security;

create policy "iir_read_via_instruction" on public.instruction_ingredient_refs
  for select using (
    exists (
      select 1 from public.instructions i
      join public.recipes r on r.id = i.recipe_id
      join public.recipe_collections c on c.id = r.collection_id
      where i.id = instruction_ingredient_refs.instruction_id
        and (c.owner_id = auth.uid() or c.is_public)
    )
  );
create policy "iir_write_via_instruction" on public.instruction_ingredient_refs
  for all using (
    exists (
      select 1 from public.instructions i
      join public.recipes r on r.id = i.recipe_id
      join public.recipe_collections c on c.id = r.collection_id
      where i.id = instruction_ingredient_refs.instruction_id and c.owner_id = auth.uid()
    )
  );

-- ---------- Conversion rules ----------
create table public.conversion_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  recipe_id uuid references public.recipes(id) on delete cascade, -- null = house rule
  from_unit text not null,
  to_unit text not null,
  factor numeric not null check (factor > 0),
  ingredient_name text,
  priority text not null check (priority in ('HOUSE', 'RECIPE', 'STANDARD'))
);

create index conversion_rules_owner_idx on public.conversion_rules(owner_id);

alter table public.conversion_rules enable row level security;

create policy "conv_own_all" on public.conversion_rules
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ---------- Public collections view ----------
create or replace view public.public_collections
with (security_invoker = true) as
  select
    rc.id,
    rc.title,
    rc.source_type,
    rc.author,
    rc.cover_image_path,
    p.display_name as owner_name,
    count(r.id) as recipe_count
  from public.recipe_collections rc
  join public.profiles p on rc.owner_id = p.id
  left join public.recipes r on r.collection_id = rc.id
  where rc.is_public = true
  group by rc.id, p.display_name;

-- ---------- Fork RPC ----------
create or replace function public.fork_collection(source_collection_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_collection_id uuid;
  src public.recipe_collections%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into src from public.recipe_collections
  where id = source_collection_id and is_public = true;
  if not found then
    raise exception 'Collection not found or not public';
  end if;

  insert into public.recipe_collections (
    owner_id, title, source_type, author, isbn, publisher, publication_year,
    description, notes, source_url, date_accessed, site_name,
    is_public, forked_from
  )
  values (
    auth.uid(), src.title, src.source_type, src.author, src.isbn, src.publisher,
    src.publication_year, src.description, src.notes, src.source_url,
    src.date_accessed, src.site_name, false, src.id
  )
  returning id into new_collection_id;

  -- Build a mapping from old recipe ids to new recipe ids so we can
  -- also carry ingredients and instructions over.
  create temporary table _recipe_map(old_id uuid, new_id uuid) on commit drop;
  create temporary table _ing_map(old_id uuid, new_id uuid) on commit drop;
  create temporary table _step_map(old_id uuid, new_id uuid) on commit drop;

  with inserted as (
    insert into public.recipes (collection_id, title, servings_amount, servings_description, sort_order)
    select new_collection_id, r.title, r.servings_amount, r.servings_description, r.sort_order
    from public.recipes r where r.collection_id = src.id
    returning id, sort_order, title
  ),
  old_ordered as (
    select id, sort_order, title from public.recipes where collection_id = src.id
  )
  insert into _recipe_map(old_id, new_id)
  select o.id, i.id
  from old_ordered o
  join inserted i on i.sort_order = o.sort_order and i.title = o.title;

  with inserted as (
    insert into public.ingredients (
      recipe_id, sort_order, type, name, preparation, notes,
      quantity_type, quantity_amount, quantity_whole, quantity_numerator,
      quantity_denominator, quantity_min, quantity_max, quantity_unit
    )
    select m.new_id, i.sort_order, i.type, i.name, i.preparation, i.notes,
           i.quantity_type, i.quantity_amount, i.quantity_whole, i.quantity_numerator,
           i.quantity_denominator, i.quantity_min, i.quantity_max, i.quantity_unit
    from public.ingredients i
    join _recipe_map m on m.old_id = i.recipe_id
    returning id, recipe_id, sort_order, name
  ),
  old_ordered as (
    select i.id, m.new_id as new_recipe_id, i.sort_order, i.name
    from public.ingredients i join _recipe_map m on m.old_id = i.recipe_id
  )
  insert into _ing_map(old_id, new_id)
  select o.id, ins.id
  from old_ordered o
  join inserted ins
    on ins.recipe_id = o.new_recipe_id
   and ins.sort_order = o.sort_order
   and ins.name = o.name;

  with inserted as (
    insert into public.instructions (recipe_id, step_number, text)
    select m.new_id, s.step_number, s.text
    from public.instructions s
    join _recipe_map m on m.old_id = s.recipe_id
    returning id, recipe_id, step_number
  ),
  old_ordered as (
    select s.id, m.new_id as new_recipe_id, s.step_number
    from public.instructions s join _recipe_map m on m.old_id = s.recipe_id
  )
  insert into _step_map(old_id, new_id)
  select o.id, ins.id
  from old_ordered o
  join inserted ins
    on ins.recipe_id = o.new_recipe_id
   and ins.step_number = o.step_number;

  insert into public.instruction_ingredient_refs (instruction_id, ingredient_id)
  select sm.new_id, im.new_id
  from public.instruction_ingredient_refs ref
  join _step_map sm on sm.old_id = ref.instruction_id
  join _ing_map im on im.old_id = ref.ingredient_id;

  return new_collection_id;
end;
$$;

grant execute on function public.fork_collection(uuid) to authenticated;

-- ---------- updated_at triggers ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger recipe_collections_updated
  before update on public.recipe_collections
  for each row execute function public.touch_updated_at();
create trigger recipes_updated
  before update on public.recipes
  for each row execute function public.touch_updated_at();
