-- Owners need to distinguish "I unpublished this" from "an admin took it
-- down". Add a soft state + reason to recipe_collections, keep them in
-- sync from the moderation RPCs, and surface them in the owner's UI so
-- the experience is transparent.
--
-- `moderation_state` = 'ACTIVE' (default) | 'TAKEN_DOWN'. When an admin
-- takes a collection down it flips to TAKEN_DOWN; owner republishing via
-- the normal UI flips back to ACTIVE. Admin `republish` of course also
-- flips back.

alter table public.recipe_collections
  add column moderation_state text not null default 'ACTIVE'
    check (moderation_state in ('ACTIVE', 'TAKEN_DOWN')),
  add column moderation_reason text;

-- Update the two admin RPCs so they maintain the state column. We could
-- put the logic in a trigger on recipe_collections, but then a legitimate
-- owner-driven private flip would get misclassified. Keeping it explicit
-- in the RPCs is clearer.

create or replace function public.moderation_unpublish_collection(
  target_collection_id uuid,
  reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  update public.recipe_collections
    set is_public = false,
        moderation_state = 'TAKEN_DOWN',
        moderation_reason = reason
    where id = target_collection_id;
  insert into public.moderation_actions (admin_id, action, target_type, target_id, reason)
    values (auth.uid(), 'UNPUBLISH', 'COLLECTION', target_collection_id, reason);
  update public.reports
    set status = 'ACTIONED', resolved_at = now(), resolved_by = auth.uid()
    where target_type = 'COLLECTION' and target_id = target_collection_id and status = 'OPEN';
end;
$$;

create or replace function public.moderation_republish_collection(
  target_collection_id uuid,
  reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  update public.recipe_collections
    set is_public = true,
        moderation_state = 'ACTIVE',
        moderation_reason = null
    where id = target_collection_id;
  insert into public.moderation_actions (admin_id, action, target_type, target_id, reason)
    values (auth.uid(), 'REPUBLISH', 'COLLECTION', target_collection_id, reason);
end;
$$;

-- When an owner republishes a taken-down collection, we don't want to
-- silently bypass the moderation decision. Block the flip if the row is
-- TAKEN_DOWN and the caller isn't an admin. Admins go through the
-- `moderation_republish_collection` RPC which clears the state.
create or replace function public.enforce_publishing_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_public then
    if exists (
      select 1 from public.profiles where id = new.owner_id and disabled = true
    ) then
      raise exception 'This account is disabled and cannot publish collections.'
        using errcode = 'P0001';
    end if;
    if new.moderation_state = 'TAKEN_DOWN' and not public.is_admin(auth.uid()) then
      raise exception 'This collection was taken down by a moderator and cannot be republished without admin review.'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
