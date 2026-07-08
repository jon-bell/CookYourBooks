-- Fold recipe children (ingredients, instructions, instruction_ingredient_refs)
-- into two JSONB columns on the recipe row: recipes.ingredients /
-- recipes.instructions (refs nest inside each instruction as `ingredientRefs`).
--
-- Rationale: no server-side query ever filters/searches/aggregates on child
-- content — every access is whole-recipe, keyed by recipe_id. The normalized
-- layout instead forced denormalized owner_id/household_id on all three
-- children, ~6 maintenance trigger functions, 3x(read+ins+upd+del) RLS policies,
-- a delete-all-then-reinsert save_recipes_graph, id-remap choreography in
-- fork_collection, and child realtime subscriptions. All of that disappears here.
--
-- Big-bang (app is pre-launch): no dual-write window. The wire/JSON contract
-- (camelCase keys = domain field names) is packages/db/src/recipeJson.ts; the
-- client stores the same shape as JSON text in the local-SQLite mirror.

-- ---------- 1. Add columns ----------
-- Nullable (no NOT NULL DEFAULT '[]' — that would rewrite the whole table under
-- lock). New inserts via save_recipes_graph / fork always set them; readers
-- treat NULL as [].
alter table public.recipes
  add column if not exists ingredients  jsonb,
  add column if not exists instructions jsonb;

-- ---------- 2. Backfill from the child tables ----------
-- Suppress recipes_updated so this does NOT bump updated_at (a bump would
-- restamp every row with one timestamp and force every device into a full
-- keyset re-pull). jsonb_strip_nulls (recursive) drops absent fields so the
-- JSON matches the "omit undefined" serializer exactly, and collapses the full
-- quantity object down to its discriminated StoredQuantity shape.
alter table public.recipes disable trigger recipes_updated;

update public.recipes r
   set ingredients = coalesce((
     select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'id', i.id,
              'type', i.type,
              'name', i.name,
              'preparation', i.preparation,
              'notes', i.notes,
              'description', case when i.type = 'VAGUE' then i.description else null end,
              'linkedRecipeId', i.linked_recipe_id,
              'linkSource', i.link_source,
              'quantity', case when i.quantity_type is null then null else jsonb_build_object(
                 'type', i.quantity_type,
                 'amount', i.quantity_amount,
                 'whole', i.quantity_whole,
                 'numerator', i.quantity_numerator,
                 'denominator', i.quantity_denominator,
                 'min', i.quantity_min,
                 'max', i.quantity_max,
                 'unit', coalesce(i.quantity_unit, '')) end))
            order by i.sort_order)
     from public.ingredients i where i.recipe_id = r.id), '[]'::jsonb);

update public.recipes r
   set instructions = coalesce((
     select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'id', s.id,
              'stepNumber', s.step_number,
              'text', s.text,
              'temperature', case when s.temperature_value is not null and s.temperature_unit is not null
                 then jsonb_build_object('value', s.temperature_value, 'unit', s.temperature_unit)
                 else null end,
              'subInstructions', case when jsonb_array_length(coalesce(s.sub_instructions, '[]'::jsonb)) > 0
                 then s.sub_instructions else null end,
              'simplifiedSteps', s.simplified_steps,
              'notes', s.notes,
              'ingredientRefs', (
                 select jsonb_agg(jsonb_build_object(
                          'ingredientId', ref.ingredient_id,
                          'quantity', case when ref.consumed_quantity_type is null then null else jsonb_build_object(
                             'type', ref.consumed_quantity_type,
                             'amount', ref.consumed_quantity_amount,
                             'whole', ref.consumed_quantity_whole,
                             'numerator', ref.consumed_quantity_numerator,
                             'denominator', ref.consumed_quantity_denominator,
                             'min', ref.consumed_quantity_min,
                             'max', ref.consumed_quantity_max,
                             'unit', coalesce(ref.consumed_quantity_unit, '')) end)
                          order by ref.ingredient_id)
                 from public.instruction_ingredient_refs ref where ref.instruction_id = s.id)))
            order by s.step_number)
     from public.instructions s where s.recipe_id = r.id), '[]'::jsonb);

alter table public.recipes enable trigger recipes_updated;

-- ---------- 3. Verify the backfill BEFORE dropping the source tables ----------
do $$
declare v_bad int;
begin
  select count(*) into v_bad
  from public.recipes r
  left join (select recipe_id, count(*) c from public.ingredients group by recipe_id) ic
         on ic.recipe_id = r.id
  where coalesce(jsonb_array_length(r.ingredients), 0) <> coalesce(ic.c, 0);
  if v_bad > 0 then
    raise exception 'ingredient backfill mismatch on % recipe(s)', v_bad;
  end if;

  select count(*) into v_bad
  from public.recipes r
  left join (select recipe_id, count(*) c from public.instructions group by recipe_id) sc
         on sc.recipe_id = r.id
  where coalesce(jsonb_array_length(r.instructions), 0) <> coalesce(sc.c, 0);
  if v_bad > 0 then
    raise exception 'instruction backfill mismatch on % recipe(s)', v_bad;
  end if;
end $$;

-- ---------- 4. save_recipes_graph: single recipe upsert, no children ----------
-- The client now embeds `ingredients` / `instructions` directly on the recipe
-- object, so jsonb_populate_recordset lands them in the jsonb columns. has_content
-- is derived from the two arrays here (its child triggers are dropped below).
create or replace function public.save_recipes_graph(p_recipes jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_recipes jsonb;
begin
  if p_recipes is null or jsonb_typeof(p_recipes) <> 'array' then
    raise exception 'save_recipes_graph: p_recipes must be a jsonb array';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_recipes) item
    where jsonb_typeof(item -> 'recipe') <> 'object' or (item -> 'recipe' ->> 'id') is null
  ) then
    raise exception 'save_recipes_graph: every item needs a recipe object with an id';
  end if;

  select jsonb_agg(item order by ord)
    into v_recipes
  from (
    select distinct on ((item -> 'recipe' ->> 'id')) item, ord
    from jsonb_array_elements(p_recipes) with ordinality as t(item, ord)
    order by (item -> 'recipe' ->> 'id'), ord desc
  ) d;

  if v_recipes is null then
    return;
  end if;

  insert into public.recipes
  select * from jsonb_populate_recordset(
    null::public.recipes,
    (select jsonb_agg(
        ((item -> 'recipe') - 'created_at' - 'updated_at' - 'has_content')
        || jsonb_build_object(
             'created_at', now(),
             'updated_at', now(),
             'ingredients', coalesce(item -> 'recipe' -> 'ingredients', '[]'::jsonb),
             'instructions', coalesce(item -> 'recipe' -> 'instructions', '[]'::jsonb),
             'has_content',
               jsonb_array_length(coalesce(item -> 'recipe' -> 'ingredients', '[]'::jsonb)) > 0
               or jsonb_array_length(coalesce(item -> 'recipe' -> 'instructions', '[]'::jsonb)) > 0))
       from jsonb_array_elements(v_recipes) item))
  on conflict (id) do update set
    collection_id        = excluded.collection_id,
    title                = excluded.title,
    servings_amount      = excluded.servings_amount,
    servings_description = excluded.servings_description,
    sort_order           = excluded.sort_order,
    notes                = excluded.notes,
    parent_recipe_id     = excluded.parent_recipe_id,
    description          = excluded.description,
    time_estimate        = excluded.time_estimate,
    equipment            = excluded.equipment,
    book_title           = excluded.book_title,
    page_numbers         = excluded.page_numbers,
    source_image_text    = excluded.source_image_text,
    servings_amount_max  = excluded.servings_amount_max,
    starred              = excluded.starred,
    source_url           = excluded.source_url,
    cover_image_path     = excluded.cover_image_path,
    ingredients          = excluded.ingredients,
    instructions         = excluded.instructions,
    has_content          = excluded.has_content;
end;
$$;
revoke all on function public.save_recipes_graph(jsonb) from public;
grant execute on function public.save_recipes_graph(jsonb) to authenticated;

-- ---------- 5. fork_collection: copy recipe rows incl. JSON verbatim ----------
-- The temp-table id-remap choreography is gone: refs live inside the
-- instructions JSON and reference ingredient ids WITHIN the same blob, which we
-- copy verbatim. Also fixes the old column-subset quirk by carrying the recipe
-- body columns (parent_recipe_id / starred deliberately left at defaults —
-- a fork shouldn't inherit a cross-collection parent link or the source's star).
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

  set local statement_timeout = '60s';

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

  insert into public.recipes (
    id, collection_id, title, servings_amount, servings_description, sort_order,
    description, notes, time_estimate, equipment, book_title, page_numbers,
    source_image_text, servings_amount_max, cover_image_path,
    ingredients, instructions, has_content
  )
  select gen_random_uuid(), new_collection_id, r.title, r.servings_amount,
         r.servings_description, r.sort_order,
         r.description, r.notes, r.time_estimate, r.equipment, r.book_title,
         r.page_numbers, r.source_image_text, r.servings_amount_max, r.cover_image_path,
         r.ingredients, r.instructions, r.has_content
  from public.recipes r
  where r.collection_id = src.id;

  return new_collection_id;
end;
$$;
grant execute on function public.fork_collection(uuid) to authenticated;

-- ---------- 6. Embeddings: a child edit is now a recipes UPDATE ----------
-- Widen recipes_enqueue_embed to fire when the folded columns change, then drop
-- the child-table enqueue trigger/function.
create or replace function public.recipes_enqueue_embed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform public.enqueue_recipe_embed_job(NEW.id);
  elsif TG_OP = 'UPDATE' then
    if NEW.title is distinct from OLD.title
       or NEW.description is distinct from OLD.description
       or NEW.notes is distinct from OLD.notes
       or NEW.book_title is distinct from OLD.book_title
       or NEW.equipment is distinct from OLD.equipment
       or NEW.ingredients is distinct from OLD.ingredients
       or NEW.instructions is distinct from OLD.instructions then
      perform public.enqueue_recipe_embed_job(NEW.id);
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists ingredients_enqueue_embed_aiud on public.ingredients;
drop function if exists public.ingredients_enqueue_embed();

-- ---------- 7. refresh_household_denorm: drop the child UPDATEs ----------
create or replace function public.refresh_household_denorm(p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_hh uuid;
begin
  set local statement_timeout = '120s';
  perform set_config('app.denorm_in_progress', 'on', true);
  v_hh := public.owner_shared_household(p_owner);
  update public.recipe_collections   set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipes              set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.cooking_events       set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipe_tags          set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.collection_notes     set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  -- LLM Cost Center cost tables:
  update public.import_item_attempts set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.bakeoff_variants     set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.rewrite_jobs         set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.misc_llm_usage       set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.remix_jobs           set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  -- Activity feed queues:
  update public.recipe_embedding_jobs set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipe_cover_jobs     set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  perform set_config('app.denorm_in_progress', '', true);
end;
$$;
revoke all on function public.refresh_household_denorm(uuid) from public, anon, authenticated;

-- ---------- 7b. rewrite_complete: patch simplifiedSteps into the JSON ----------
-- The instruction-rewrite worker forwarded per-instruction `simplifiedSteps`;
-- it used to UPDATE instructions.simplified_steps. Now it patches the matching
-- element of recipes.instructions in place (matched by the stored `id`).
create or replace function public.rewrite_complete(
  p_job_id uuid, p_claim_token text, p_attempt jsonb, p_result jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  job_recipe uuid;
begin
  select recipe_id into job_recipe
    from public.rewrite_jobs
    where id = p_job_id and claim_token = p_claim_token;
  if job_recipe is null then
    return false;
  end if;

  -- Rebuild the instructions array, setting `simplifiedSteps` on each
  -- element whose id matches a rewritten entry. Bumps updated_at so the
  -- pull watermark moves past this point.
  with rewrites as (
    select (e ->> 'instructionId') as iid, e -> 'simplifiedSteps' as ss
    from jsonb_array_elements(coalesce(p_result -> 'rewritten', '[]'::jsonb)) e
  )
  update public.recipes r
     set instructions = coalesce((
           select jsonb_agg(
                    case when rw.ss is not null
                         then jsonb_set(elem, '{simplifiedSteps}', rw.ss)
                         else elem end
                    order by ord)
           from jsonb_array_elements(coalesce(r.instructions, '[]'::jsonb))
                with ordinality as t(elem, ord)
           left join rewrites rw on rw.iid = elem ->> 'id'
         ), r.instructions),
         updated_at = now()
   where r.id = job_recipe;

  update public.rewrite_jobs set
    status = 'DONE',
    result_json = p_result,
    prompt_tokens = coalesce((p_attempt->>'prompt_tokens')::int, prompt_tokens),
    completion_tokens = coalesce((p_attempt->>'completion_tokens')::int, completion_tokens),
    cost_usd_micros = coalesce((p_attempt->>'cost_usd_micros')::bigint, cost_usd_micros),
    latency_ms = coalesce((p_attempt->>'latency_ms')::int, latency_ms),
    last_error = null,
    claim_token = null,
    updated_at = now()
    where id = p_job_id;

  return true;
end;
$$;

-- ---------- 7c. cover_jobs_enqueue: use has_content, not child EXISTS ----------
create or replace function public.cover_jobs_enqueue(p_scope text, p_target_id uuid default null::uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_household uuid := nullif(auth.jwt() ->> 'household_id', '')::uuid;
  v_count integer;
begin
  if v_caller is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_scope not in ('recipe', 'collection', 'library') then
    raise exception 'Unknown scope %', p_scope using errcode = '22023';
  end if;
  if p_scope in ('recipe', 'collection') and p_target_id is null then
    raise exception 'p_target_id is required for scope %', p_scope using errcode = '22023';
  end if;

  with inserted as (
    insert into public.recipe_cover_jobs (recipe_id, owner_id, requested_by)
    select r.id, r.owner_id, v_caller
      from public.recipes r
     where case p_scope
             when 'recipe' then
               r.id = p_target_id
               and (r.owner_id = v_caller
                    or (r.owner_id <> v_caller and r.household_id = v_household))
             when 'collection' then
               r.collection_id = p_target_id
               and (r.owner_id = v_caller
                    or (r.owner_id <> v_caller and r.household_id = v_household))
               and r.has_content
             else
               r.owner_id = v_caller
               and r.has_content
           end
    on conflict (recipe_id) where status in ('PENDING', 'CLAIMED') do nothing
    returning 1
  )
  select count(*) into v_count from inserted;
  return v_count;
end;
$$;

-- ---------- 7d. CLI / MCP RPCs: read/write JSON, preserve snake_case API ----------
-- External snake_case contract preserved (apps/cli, _mcp-tools.ts, e2e specs):
-- ingredients are flat with quantity_* fields; instructions are
-- {id, step_number, text, ingredient_refs:[ingredient_id,...]}.
create or replace function public.cli_get_recipe(raw_token text, recipe_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  owner uuid := public.cli_verify_token(raw_token);
  result jsonb;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', r.id,
    'title', r.title,
    'notes', r.notes,
    'parent_recipe_id', r.parent_recipe_id,
    'collection_id', r.collection_id,
    'collection_title', rc.title,
    'servings_amount', r.servings_amount,
    'servings_description', r.servings_description,
    'sort_order', r.sort_order,
    'ingredients', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e ->> 'id',
               'sort_order', (ord - 1),
               'type', e ->> 'type',
               'name', e ->> 'name',
               'preparation', e ->> 'preparation',
               'notes', e ->> 'notes',
               'description', e ->> 'description',
               'linked_recipe_id', e ->> 'linkedRecipeId',
               'link_source', e ->> 'linkSource',
               'quantity_type', e -> 'quantity' ->> 'type',
               'quantity_amount', e -> 'quantity' -> 'amount',
               'quantity_whole', e -> 'quantity' -> 'whole',
               'quantity_numerator', e -> 'quantity' -> 'numerator',
               'quantity_denominator', e -> 'quantity' -> 'denominator',
               'quantity_min', e -> 'quantity' -> 'min',
               'quantity_max', e -> 'quantity' -> 'max',
               'quantity_unit', e -> 'quantity' ->> 'unit')
             order by ord)
      from jsonb_array_elements(coalesce(r.ingredients, '[]'::jsonb)) with ordinality as t(e, ord)
    ), '[]'::jsonb),
    'instructions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e ->> 'id',
               'step_number', coalesce((e ->> 'stepNumber')::int, ord::int),
               'text', e ->> 'text',
               'ingredient_refs', coalesce((
                 select jsonb_agg(ref ->> 'ingredientId')
                 from jsonb_array_elements(coalesce(e -> 'ingredientRefs', '[]'::jsonb)) ref
               ), '[]'::jsonb))
             order by coalesce((e ->> 'stepNumber')::int, ord::int), ord)
      from jsonb_array_elements(coalesce(r.instructions, '[]'::jsonb)) with ordinality as t(e, ord)
    ), '[]'::jsonb)
  )
  into result
  from public.recipes r
  join public.recipe_collections rc on rc.id = r.collection_id
  where r.id = recipe_id and rc.owner_id = owner;

  if result is null then
    raise exception 'Recipe not found or not owned by caller' using errcode = '42501';
  end if;

  return result;
end;
$function$;

create or replace function public.cli_search_recipes(raw_token text, query text, max_results integer default 25)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  owner uuid := public.cli_verify_token(raw_token);
  q text;
  capped integer;
  hits jsonb;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;
  q := btrim(coalesce(query, ''));
  if q = '' then
    return '[]'::jsonb;
  end if;
  capped := greatest(1, least(coalesce(max_results, 25), 100));

  select coalesce(jsonb_agg(row_to_json(h)), '[]'::jsonb)
    into hits
  from (
    select distinct r.id as recipe_id,
                    r.title as recipe_title,
                    rc.id as collection_id,
                    rc.title as collection_title
    from public.recipes r
    join public.recipe_collections rc on rc.id = r.collection_id
    where rc.owner_id = owner
      and (r.title ilike '%' || q || '%'
           or exists (
             select 1
             from jsonb_array_elements(coalesce(r.ingredients, '[]'::jsonb)) e
             where e ->> 'name' ilike '%' || q || '%'))
    order by r.title asc
    limit capped
  ) h;

  return hits;
end;
$function$;

create or replace function public.cli_import_recipe(raw_token text, target_collection_id uuid, recipe jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  owner uuid := public.cli_verify_token(raw_token);
  col_id uuid := target_collection_id;
  new_recipe_id uuid;
  ingredient jsonb;
  instr jsonb;
  ing_map jsonb := '{}'::jsonb;
  old_ing_id text;
  new_ing_id uuid;
  v_quantity jsonb;
  v_ingredients jsonb := '[]'::jsonb;
  v_instructions jsonb := '[]'::jsonb;
  v_refs jsonb;
  raw_ref_id text;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;
  if recipe is null or recipe ->> 'title' is null then
    raise exception 'recipe.title is required' using errcode = '22023';
  end if;

  if col_id is null then
    insert into public.recipe_collections (owner_id, title, source_type)
      values (owner, 'CLI imports', 'PERSONAL')
      returning id into col_id;
  else
    perform 1 from public.recipe_collections
      where id = col_id and owner_id = owner;
    if not found then
      raise exception 'Target collection not found or not owned by caller'
        using errcode = '42501';
    end if;
  end if;

  -- Ingredients -> Stored camelCase. Track old->new id so step refs remap.
  for ingredient in
    select * from jsonb_array_elements(coalesce(recipe -> 'ingredients', '[]'::jsonb))
  loop
    new_ing_id := gen_random_uuid();
    old_ing_id := ingredient ->> 'id';
    if old_ing_id is not null then
      ing_map := ing_map || jsonb_build_object(old_ing_id, to_jsonb(new_ing_id));
    end if;

    if ingredient ->> 'quantity_type' is not null then
      v_quantity := jsonb_strip_nulls(jsonb_build_object(
        'type', ingredient ->> 'quantity_type',
        'amount', ingredient -> 'quantity_amount',
        'whole', ingredient -> 'quantity_whole',
        'numerator', ingredient -> 'quantity_numerator',
        'denominator', ingredient -> 'quantity_denominator',
        'min', ingredient -> 'quantity_min',
        'max', ingredient -> 'quantity_max',
        'unit', coalesce(ingredient ->> 'quantity_unit', '')));
    else
      v_quantity := null;
    end if;

    v_ingredients := v_ingredients || jsonb_strip_nulls(jsonb_build_object(
      'id', new_ing_id,
      'type', coalesce(ingredient ->> 'type', 'VAGUE'),
      'name', coalesce(ingredient ->> 'name', ''),
      'preparation', ingredient ->> 'preparation',
      'notes', ingredient ->> 'notes',
      'description', ingredient ->> 'description',
      'quantity', v_quantity));
  end loop;

  -- Instructions -> Stored camelCase, refs remapped through ing_map.
  for instr in
    select * from jsonb_array_elements(coalesce(recipe -> 'instructions', '[]'::jsonb))
  loop
    v_refs := '[]'::jsonb;
    for raw_ref_id in
      select value #>> '{}'
      from jsonb_array_elements(coalesce(instr -> 'ingredient_refs', '[]'::jsonb))
    loop
      if ing_map ? raw_ref_id then
        v_refs := v_refs || jsonb_build_object('ingredientId', ing_map ->> raw_ref_id);
      end if;
    end loop;

    v_instructions := v_instructions || jsonb_strip_nulls(jsonb_build_object(
      'id', gen_random_uuid(),
      'stepNumber', coalesce((instr ->> 'step_number')::int, 1),
      'text', coalesce(instr ->> 'text', ''),
      'ingredientRefs', case when jsonb_array_length(v_refs) > 0 then v_refs else null end));
  end loop;

  insert into public.recipes (
    collection_id, title, servings_amount, servings_description, sort_order,
    ingredients, instructions, has_content
  )
  values (
    col_id,
    recipe ->> 'title',
    (recipe ->> 'servings_amount')::numeric,
    recipe ->> 'servings_description',
    coalesce((recipe ->> 'sort_order')::int, 0),
    v_ingredients,
    v_instructions,
    jsonb_array_length(v_ingredients) > 0 or jsonb_array_length(v_instructions) > 0
  )
  returning id into new_recipe_id;

  return new_recipe_id;
end;
$function$;

create or replace function public.cli_export_library(raw_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  owner uuid := public.cli_verify_token(raw_token);
  collections jsonb;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(col), '[]'::jsonb)
    into collections
  from (
    select jsonb_build_object(
      'id', rc.id,
      'title', rc.title,
      'source_type', rc.source_type,
      'is_public', rc.is_public,
      'author', rc.author,
      'isbn', rc.isbn,
      'publisher', rc.publisher,
      'publication_year', rc.publication_year,
      'description', rc.description,
      'notes', rc.notes,
      'source_url', rc.source_url,
      'date_accessed', rc.date_accessed,
      'site_name', rc.site_name,
      'recipes', coalesce((
        select jsonb_agg(recipe_json order by recipe_sort)
        from (
          select r.sort_order as recipe_sort,
            jsonb_build_object(
              'id', r.id,
              'title', r.title,
              'servings_amount', r.servings_amount,
              'servings_description', r.servings_description,
              'sort_order', r.sort_order,
              'ingredients', coalesce((
                select jsonb_agg(jsonb_build_object(
                         'id', e ->> 'id',
                         'sort_order', (ord - 1),
                         'type', e ->> 'type',
                         'name', e ->> 'name',
                         'preparation', e ->> 'preparation',
                         'notes', e ->> 'notes',
                         'description', e ->> 'description',
                         'linked_recipe_id', e ->> 'linkedRecipeId',
                         'link_source', e ->> 'linkSource',
                         'quantity_type', e -> 'quantity' ->> 'type',
                         'quantity_amount', e -> 'quantity' -> 'amount',
                         'quantity_whole', e -> 'quantity' -> 'whole',
                         'quantity_numerator', e -> 'quantity' -> 'numerator',
                         'quantity_denominator', e -> 'quantity' -> 'denominator',
                         'quantity_min', e -> 'quantity' -> 'min',
                         'quantity_max', e -> 'quantity' -> 'max',
                         'quantity_unit', e -> 'quantity' ->> 'unit')
                       order by ord)
                from jsonb_array_elements(coalesce(r.ingredients, '[]'::jsonb)) with ordinality as t(e, ord)
              ), '[]'::jsonb),
              'instructions', coalesce((
                select jsonb_agg(jsonb_build_object(
                         'id', e ->> 'id',
                         'step_number', coalesce((e ->> 'stepNumber')::int, ord::int),
                         'text', e ->> 'text',
                         'ingredient_refs', coalesce((
                           select jsonb_agg(ref ->> 'ingredientId')
                           from jsonb_array_elements(coalesce(e -> 'ingredientRefs', '[]'::jsonb)) ref
                         ), '[]'::jsonb))
                       order by coalesce((e ->> 'stepNumber')::int, ord::int), ord)
                from jsonb_array_elements(coalesce(r.instructions, '[]'::jsonb)) with ordinality as t(e, ord)
              ), '[]'::jsonb)
            ) as recipe_json
          from public.recipes r
          where r.collection_id = rc.id
        ) inner_r
      ), '[]'::jsonb)
    ) as col
    from public.recipe_collections rc
    where rc.owner_id = owner
    order by rc.created_at asc
  ) outer_c;

  return jsonb_build_object(
    'exported_at', now(),
    'owner_id', owner,
    'collections', collections
  );
end;
$function$;

-- ---------- 8. Drop the has_content child triggers + recipe-move cascade ----------
-- has_content is now derived inside save_recipes_graph (and copied by fork).
drop trigger if exists ingredients_has_content_ins on public.ingredients;
drop trigger if exists ingredients_has_content_del on public.ingredients;
drop trigger if exists ingredients_has_content_upd on public.ingredients;
drop trigger if exists instructions_has_content_ins on public.instructions;
drop trigger if exists instructions_has_content_del on public.instructions;
drop trigger if exists instructions_has_content_upd on public.instructions;
drop function if exists public.recipes_refresh_has_content();

-- recipe collection-move cascade to children — no children to cascade to now.
-- (recipes.owner_id/household_id are still stamped by set_recipe_owner_from_collection.)
drop trigger if exists recipes_sync_children_owner on public.recipes;
drop function if exists public.sync_children_owner_on_recipe_move();

-- ---------- 9. Drop the child tables + their owner-stamp functions ----------
-- Policies, indexes, per-table triggers, FKs, and realtime-publication
-- membership all drop with the tables (cascade).
drop table if exists public.instruction_ingredient_refs cascade;
drop table if exists public.instructions cascade;
drop table if exists public.ingredients cascade;

drop function if exists public.set_child_owner_from_recipe() cascade;
drop function if exists public.set_ref_owner_from_instruction() cascade;
