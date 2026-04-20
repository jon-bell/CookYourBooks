-- CLI access tokens.
--
-- Users mint tokens from the web or mobile app and plug them into the
-- `cyb` CLI (apps/cli) to drive import/export from scripts or pipelines.
-- Design goals:
--   - Raw tokens are shown once, then only the SHA-256 hash is stored
--     server-side. Revoking = deleting the row.
--   - All CLI operations go through a small set of `security definer`
--     RPCs that accept the raw token as an argument, verify it, update
--     `last_used_at`, and scope the operation to the token's owner.
--   - No admin, public-collection, or moderation surface is reachable
--     via CLI tokens — only the caller's own recipes / collections.

-- ---------- Table ----------

create table public.cli_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  -- sha256 of the raw token (hex, 64 chars). Never reversible.
  token_hash text not null unique,
  -- First 12 characters of the raw token, stored so the UI can show
  -- "cyb_cli_3a9f…" without exposing the whole secret. Safe to display.
  prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index cli_tokens_owner_idx on public.cli_tokens(owner_id, created_at desc);

alter table public.cli_tokens enable row level security;

-- Owners can read their own tokens (metadata only — the hash isn't the
-- secret either way). Deletes also go through RLS so the revoke button
-- in the UI is a plain `delete` call.
create policy "cli_tokens_read_own" on public.cli_tokens
  for select using (owner_id = auth.uid());
create policy "cli_tokens_delete_own" on public.cli_tokens
  for delete using (owner_id = auth.uid());
-- Inserts happen through the `cli_issue_token` RPC (security definer),
-- not via PostgREST directly — we never want the client writing the
-- token hash itself.

-- ---------- Issue ----------

-- Issues a new token for the caller. Returns the raw token string — the
-- only time it's ever transmitted. UI is responsible for showing it
-- once; we don't persist it in plaintext.
create or replace function public.cli_issue_token(token_name text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  caller uuid := auth.uid();
  random_bytes bytea;
  raw_token text;
  hash text;
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if token_name is null or length(btrim(token_name)) = 0 then
    raise exception 'Token name required' using errcode = '22023';
  end if;

  -- 24 random bytes → 48 hex characters. `cyb_cli_` prefix makes leaked
  -- tokens visually identifiable in logs / GitHub secret scanning.
  random_bytes := extensions.gen_random_bytes(24);
  raw_token := 'cyb_cli_' || encode(random_bytes, 'hex');
  hash := encode(extensions.digest(raw_token, 'sha256'), 'hex');

  insert into public.cli_tokens (owner_id, name, token_hash, prefix)
    values (caller, btrim(token_name), hash, substr(raw_token, 1, 12));

  return raw_token;
end;
$$;

grant execute on function public.cli_issue_token(text) to authenticated;

-- ---------- Internal verify helper ----------

-- Hashes the raw token and returns the owner's id, bumping
-- `last_used_at`. Returns NULL on mismatch. Every `cli_*` operation
-- starts by calling this. NOT granted to clients directly.
create or replace function public.cli_verify_token(raw_token text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  hash text;
  owner uuid;
begin
  if raw_token is null or position('cyb_cli_' in raw_token) <> 1 then
    return null;
  end if;
  hash := encode(extensions.digest(raw_token, 'sha256'), 'hex');
  update public.cli_tokens
    set last_used_at = now()
    where token_hash = hash
    returning owner_id into owner;
  return owner;
end;
$$;

-- ---------- Operations ----------

-- Dump the caller's entire library as JSON. Mirrors the in-app domain
-- shape so the CLI can round-trip data between exports and imports.
create or replace function public.cli_export_library(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
                select jsonb_agg(to_jsonb(i.*) - 'recipe_id' order by i.sort_order)
                from public.ingredients i where i.recipe_id = r.id
              ), '[]'::jsonb),
              'instructions', coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'id', ins.id,
                    'step_number', ins.step_number,
                    'text', ins.text,
                    'ingredient_refs', coalesce((
                      select jsonb_agg(ref.ingredient_id)
                      from public.instruction_ingredient_refs ref
                      where ref.instruction_id = ins.id
                    ), '[]'::jsonb)
                  )
                  order by ins.step_number
                )
                from public.instructions ins where ins.recipe_id = r.id
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
$$;

grant execute on function public.cli_export_library(text) to anon, authenticated;

-- Import a single recipe into one of the caller's collections. Expects
-- the same shape `cli_export_library` produces for its recipe entries.
-- Creates the collection if target_collection_id is null.
create or replace function public.cli_import_recipe(
  raw_token text,
  target_collection_id uuid,
  recipe jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := public.cli_verify_token(raw_token);
  col_id uuid := target_collection_id;
  new_recipe_id uuid;
  ingredient jsonb;
  instruction jsonb;
  ingredient_id_map jsonb := '{}'::jsonb;
  old_ingredient_id text;
  new_ingredient_id uuid;
  old_step_id text;
  new_step_id uuid;
  raw_ref_id text;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;
  if recipe is null or recipe->>'title' is null then
    raise exception 'recipe.title is required' using errcode = '22023';
  end if;

  -- If no collection specified, create a CLI-import staging collection
  -- on demand. Users can rename or merge it afterwards.
  if col_id is null then
    insert into public.recipe_collections (owner_id, title, source_type)
      values (owner, 'CLI imports', 'PERSONAL')
      returning id into col_id;
  else
    -- Must belong to the token's owner. Admins can't ride CLI tokens
    -- into other users' collections even if the RPC says otherwise.
    perform 1 from public.recipe_collections
      where id = col_id and owner_id = owner;
    if not found then
      raise exception 'Target collection not found or not owned by caller'
        using errcode = '42501';
    end if;
  end if;

  insert into public.recipes (
    collection_id, title, servings_amount, servings_description, sort_order
  )
  values (
    col_id,
    recipe->>'title',
    (recipe->>'servings_amount')::numeric,
    recipe->>'servings_description',
    coalesce((recipe->>'sort_order')::int, 0)
  )
  returning id into new_recipe_id;

  -- Ingredients. Keep a map of old→new id so step refs remap correctly.
  for ingredient in
    select * from jsonb_array_elements(coalesce(recipe->'ingredients', '[]'::jsonb))
  loop
    insert into public.ingredients (
      recipe_id, sort_order, type, name, preparation, notes,
      quantity_type, quantity_amount, quantity_whole, quantity_numerator,
      quantity_denominator, quantity_min, quantity_max, quantity_unit
    )
    values (
      new_recipe_id,
      coalesce((ingredient->>'sort_order')::int, 0),
      coalesce(ingredient->>'type', 'VAGUE'),
      ingredient->>'name',
      ingredient->>'preparation',
      ingredient->>'notes',
      ingredient->>'quantity_type',
      (ingredient->>'quantity_amount')::numeric,
      (ingredient->>'quantity_whole')::int,
      (ingredient->>'quantity_numerator')::int,
      (ingredient->>'quantity_denominator')::int,
      (ingredient->>'quantity_min')::numeric,
      (ingredient->>'quantity_max')::numeric,
      ingredient->>'quantity_unit'
    )
    returning id into new_ingredient_id;
    old_ingredient_id := ingredient->>'id';
    if old_ingredient_id is not null then
      ingredient_id_map := ingredient_id_map
        || jsonb_build_object(old_ingredient_id, to_jsonb(new_ingredient_id));
    end if;
  end loop;

  -- Instructions + their ingredient refs (remapped via the id map).
  for instruction in
    select * from jsonb_array_elements(coalesce(recipe->'instructions', '[]'::jsonb))
  loop
    old_step_id := instruction->>'id';
    insert into public.instructions (recipe_id, step_number, text)
    values (
      new_recipe_id,
      coalesce((instruction->>'step_number')::int, 1),
      coalesce(instruction->>'text', '')
    )
    returning id into new_step_id;

    -- Ref ids are stored as strings in the payload; they may be UUIDs
    -- (from an export round-trip) or arbitrary identifiers (from a
    -- hand-written import). Look them up in the id map as text.
    for raw_ref_id in
      select value #>> '{}'
      from jsonb_array_elements(coalesce(instruction->'ingredient_refs', '[]'::jsonb))
    loop
      if ingredient_id_map ? raw_ref_id then
        insert into public.instruction_ingredient_refs (instruction_id, ingredient_id)
          values (new_step_id, (ingredient_id_map->>raw_ref_id)::uuid);
      end if;
    end loop;
  end loop;

  return new_recipe_id;
end;
$$;

grant execute on function public.cli_import_recipe(text, uuid, jsonb)
  to anon, authenticated;
