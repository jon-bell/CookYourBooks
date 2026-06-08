-- Bulk cover generation should skip placeholder recipes.
--
-- A "placeholder" is a recipe with no ingredients AND no instructions — a
-- title-only stub (e.g. seeded from a cookbook table-of-contents) that hasn't
-- been imported yet. Generating a cover for one is pointless: the prompt is
-- built from the recipe's ingredients/instructions (buildCoverPrompt in
-- import-worker/cover.ts), so a placeholder yields "Ingredients n/a.
-- Instructions n/a" — a generic, wasted image that also burns the initiator's
-- Gemini key.
--
-- This matches the client's `has_content` notion (apps/web/src/local
-- /repositories.ts): has_content = at least one ingredient OR one instruction;
-- a placeholder is `not has_content`.
--
-- Re-creates cover_jobs_enqueue (20260626000100) adding the content filter to
-- the *bulk* scopes only — 'collection' and 'library'. The single-recipe
-- 'recipe' scope is an explicit, deliberate request, so it's left permissive
-- (the user can still force a cover on one specific recipe). Everything else
-- (RLS read predicate, grants, conflict handling) is unchanged.
create or replace function public.cover_jobs_enqueue(
  p_scope text,
  p_target_id uuid default null
) returns integer
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
             -- 'recipe': any single recipe the caller can read. Explicit
             -- request — not gated on content (the user chose this recipe).
             when 'recipe' then
               r.id = p_target_id
               and (r.owner_id = v_caller
                    or (r.owner_id <> v_caller and r.household_id = v_household))
             -- 'collection': bulk over a collection — skip placeholders.
             when 'collection' then
               r.collection_id = p_target_id
               and (r.owner_id = v_caller
                    or (r.owner_id <> v_caller and r.household_id = v_household))
               and (exists (select 1 from public.ingredients i where i.recipe_id = r.id)
                    or exists (select 1 from public.instructions ins where ins.recipe_id = r.id))
             -- 'library': bulk over the caller's own recipes — skip placeholders.
             else
               r.owner_id = v_caller
               and (exists (select 1 from public.ingredients i where i.recipe_id = r.id)
                    or exists (select 1 from public.instructions ins where ins.recipe_id = r.id))
           end
    on conflict (recipe_id) where status in ('PENDING', 'CLAIMED') do nothing
    returning 1
  )
  select count(*) into v_count from inserted;
  return v_count;
end;
$$;

revoke all on function public.cover_jobs_enqueue(text, uuid) from public, anon;
grant execute on function public.cover_jobs_enqueue(text, uuid) to authenticated;
