-- Suppress per-row side effects during refresh_household_denorm bulk UPDATEs.
--
-- refresh_household_denorm (20260629000000) runs ~14 full-library UPDATEs that
-- set household_id on every owned row when a user joins/leaves a household or
-- toggles library sharing. Each of those row updates fires per-row triggers
-- that are pointless — and actively harmful — for a household_id-only stamp:
--
--   * touch_updated_at  -> bumps updated_at on every recipe/collection/etc.
--     That makes the OWNER's own devices think their whole library changed and
--     re-pull it. This bug class previously wedged a sync watermark (see the
--     keyset-recipes-pull memory note). Co-member visibility does NOT depend on
--     this bump: co-members re-pull shared content by resetting the household
--     watermark CLIENT-SIDE on a household_members change
--     (resetHouseholdWatermarks, called from a household membership transition;
--     see apps/web/src/local/sync.ts:80-91). So skipping the bump loses nothing.
--
--   * ingredients_enqueue_embed -> UNCONDITIONALLY enqueues a recipe embed job
--     on every ingredient update. A sharing toggle would re-embed the entire
--     library = real LLM spend for zero text change.
--
--   * recipes_refresh_has_content -> statement-level EXISTS scans over the
--     children for every touched recipe. has_content can't change from a
--     household_id stamp, so the scan is pure waste.
--
-- Fix: a transaction-local GUC `app.denorm_in_progress`. refresh_household_denorm
-- sets it 'on' around its UPDATEs; the three trigger functions early-return when
-- it's set. set_config(..., is_local := true) is transaction-scoped, so an
-- aborted denorm transaction can't leak the flag into later statements.
--
-- NOT skipped (intentionally): sync_embedding_household_from_recipe
-- (20260624000000, AFTER UPDATE OF owner_id, household_id) and
-- sync_children_owner_on_recipe_move (20260612000000, AFTER UPDATE OF
-- collection_id) — the first MUST run so the embedding's denormalized
-- household_id stays correct (cheap single UPDATE), the second doesn't fire on a
-- household_id-only update. recipes_enqueue_embed only enqueues when embed-text
-- columns change, so a household_id update never trips it. All other tables the
-- denorm touches (cooking_events, recipe_tags, collection_notes, the cost/job
-- tables) bump updated_at via the same touch_updated_at function guarded below.

-- ---------- 1. touch_updated_at ----------
-- Original (20260419000000): plain `before update` trigger fn, no security
-- definer / search_path. Preserve that signature; just add the guard.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  if current_setting('app.denorm_in_progress', true) = 'on' then
    return new;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- 2. ingredients_enqueue_embed ----------
-- Original (20260605000100): security definer, set search_path = public.
-- AFTER trigger -> returns null. Guard at the top, rest verbatim.
create or replace function public.ingredients_enqueue_embed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipe uuid;
begin
  if current_setting('app.denorm_in_progress', true) = 'on' then
    return null;
  end if;
  if TG_OP = 'DELETE' then
    v_recipe := OLD.recipe_id;
  else
    v_recipe := NEW.recipe_id;
  end if;
  perform public.enqueue_recipe_embed_job(v_recipe);
  return null;
end;
$$;

-- ---------- 3. recipes_refresh_has_content ----------
-- Original (20260630000000): security definer, set search_path = public.
-- Statement-level AFTER trigger -> returns null. Guard at the top, rest verbatim.
create or replace function public.recipes_refresh_has_content()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  if current_setting('app.denorm_in_progress', true) = 'on' then
    return null;
  end if;
  if tg_op = 'INSERT' then
    select array_agg(distinct recipe_id) into v_ids from new_rows;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct recipe_id) into v_ids from old_rows;
  else
    select array_agg(distinct rid) into v_ids
    from (
      select recipe_id as rid from new_rows
      union
      select recipe_id from old_rows
    ) u;
  end if;

  if v_ids is null then
    return null;
  end if;

  update public.recipes r
     set has_content = c.computed
  from (
    select rid,
           exists (select 1 from public.ingredients i where i.recipe_id = rid)
        or exists (select 1 from public.instructions s where s.recipe_id = rid) as computed
    from unnest(v_ids) as rid
  ) c
  where r.id = c.rid
    and r.has_content is distinct from c.computed;

  return null;
end;
$$;

-- ---------- 4. refresh_household_denorm ----------
-- 20260629000000 body verbatim, wrapped in set/clear of the GUC. The body's own
-- `set local statement_timeout` is preserved. security definer + search_path
-- preserved. The clear (set to '') only resets the flag for the rest of the
-- transaction; because both set_config calls are transaction-local, an abort
-- can't leak the 'on' value.
create or replace function public.refresh_household_denorm(p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_hh uuid;
begin
  set local statement_timeout = '120s';
  perform set_config('app.denorm_in_progress', 'on', true);
  v_hh := public.owner_shared_household(p_owner);
  update public.recipe_collections          set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipes                      set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.ingredients                  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.instructions                 set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.instruction_ingredient_refs  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.cooking_events               set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipe_tags                  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.collection_notes             set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  -- LLM Cost Center cost tables:
  update public.import_item_attempts         set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.bakeoff_variants             set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.rewrite_jobs                 set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.misc_llm_usage               set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.remix_jobs                   set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  -- Activity feed queues:
  update public.recipe_embedding_jobs        set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipe_cover_jobs            set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  perform set_config('app.denorm_in_progress', '', true);
end;
$$;
revoke all on function public.refresh_household_denorm(uuid) from public, anon, authenticated;
