-- User blocking (App Store Guideline 1.2 — apps with user-generated content
-- must let a user block abusive users).
--
-- The only surface where one user sees another's content uninvited is
-- Discover (`public_collections`). Household co-members opted in to each
-- other and can leave; `/r/<uuid>` share links are content someone chose to
-- send you. So a block is: "hide everything this author publishes from my
-- Discover", enforced in the view rather than client-side so it binds on
-- every device the moment the row lands.
--
-- Blocking goes through `block_collection_owner(collection_id)` rather than a
-- direct insert: `public_collections` deliberately doesn't expose owner ids,
-- and the RPC resolves the owner server-side so it doesn't have to start.
-- It also files a USER report so the block reaches the moderation queue —
-- App Review expects a block to notify the developer, not just hide content.

create table public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

-- The view's NOT EXISTS probes (blocker_id, blocked_id) — the PK covers it.
-- This one serves the cascade from the blocked side.
create index user_blocks_blocked_idx on public.user_blocks(blocked_id);

alter table public.user_blocks enable row level security;

-- Owner-only. Blocks are private: the blocked user can't see that they
-- were blocked (no read branch for blocked_id).
create policy "user_blocks_own_read" on public.user_blocks
  for select using (blocker_id = (select auth.uid()));
create policy "user_blocks_own_delete" on public.user_blocks
  for delete using (blocker_id = (select auth.uid()));
-- No insert policy: inserts go through block_collection_owner.

grant select, delete on public.user_blocks to authenticated;

-- ---------- public_collections — hide blocked authors ----------
-- Same definition as 20260419000400_moderation.sql plus the block filter.
-- For anon, auth.uid() is NULL so the NOT EXISTS is trivially true.

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
    and coalesce(p.disabled, false) = false
    and not exists (
      select 1 from public.user_blocks b
      where b.blocker_id = (select auth.uid())
        and b.blocked_id = rc.owner_id
    )
  group by rc.id, p.display_name;

-- ---------- RPCs ----------

create or replace function public.block_collection_owner(p_collection_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
  v_title text;
begin
  if v_me is null then
    raise exception 'Sign in to block users.' using errcode = '42501';
  end if;

  -- Only public collections: a block can't be used to probe the owner of
  -- a private collection.
  select owner_id, title into v_owner, v_title
  from public.recipe_collections
  where id = p_collection_id and is_public = true;
  if v_owner is null then
    raise exception 'Collection not found.' using errcode = 'P0002';
  end if;
  if v_owner = v_me then
    raise exception 'You can''t block yourself.' using errcode = '22023';
  end if;

  insert into public.user_blocks (blocker_id, blocked_id)
  values (v_me, v_owner)
  on conflict do nothing;

  -- Notify moderation. Best-effort: the report rate limit (20/day) must
  -- never stop the block itself from taking effect.
  begin
    insert into public.reports (reporter_id, target_type, target_id, reason, message)
    values (
      v_me, 'USER', v_owner, 'OTHER',
      format('Blocked by a user from Discover (collection %s: %s)', p_collection_id, v_title)
    );
  exception when others then
    null;
  end;
end;
$$;

grant execute on function public.block_collection_owner(uuid) to authenticated;

-- The settings list needs display names; profiles are public-read, but
-- joining here keeps it one round trip.
create or replace function public.list_my_blocks()
returns table (blocked_id uuid, display_name text, created_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select b.blocked_id, p.display_name, b.created_at
  from public.user_blocks b
  join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = (select auth.uid())
  order by b.created_at desc;
$$;

grant execute on function public.list_my_blocks() to authenticated;
