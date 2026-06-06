-- Household membership RPCs.
--
-- Every membership state transition goes through one of these functions
-- so we can: (a) enforce caps and cooldowns atomically, (b) write the
-- audit row in the same transaction as the state change, (c) keep
-- household_members' RLS narrow (read-only for end users; mutations
-- bypass it via security-definer).
--
-- All RPCs raise with errcode P0001 on user-facing errors so the
-- frontend can render the message verbatim.

-- Tunable knobs. Bumping these requires a migration so the value is
-- always in the same Postgres dump as the trigger that consults it.
create or replace function public.household_cooldown_days()
returns int language sql immutable as $$ select 7 $$;

-- ---------- household_invites ----------

create table public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  -- 32-char hex token; not derivable from the id, so leaking the id
  -- (which appears in URLs once accepted) doesn't expose a valid invite.
  token text not null unique,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references public.profiles(id) on delete set null,
  revoked_at timestamptz
);

create index household_invites_household_idx on public.household_invites(household_id);
create index household_invites_token_idx on public.household_invites(token);

alter table public.household_invites enable row level security;

-- Members of the household see their household's invites (so the owner
-- can revoke them, members can see pending ones). Token lookup for
-- acceptance goes through a security-definer RPC, not RLS — so a
-- non-member can't enumerate invites or read the token field.
create policy "invites_read_household_members" on public.household_invites
  for select using (
    public.is_household_member(household_id, auth.uid())
    or public.is_admin(auth.uid())
  );
-- No INSERT / UPDATE / DELETE policies — RPCs only.

-- ---------- create_household ----------

create or replace function public.create_household(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_cooldown timestamptz;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  -- Creating a household is the entry point for sharing. Gate on the
  -- current ToS so the user accepts before producing any shareable
  -- container.
  perform public.require_current_tos();
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Household name is required.' using errcode = 'P0001';
  end if;
  if char_length(p_name) > 80 then
    raise exception 'Household name is too long (max 80 characters).' using errcode = 'P0001';
  end if;

  -- One active household per user.
  if exists (
    select 1 from public.household_members
    where user_id = v_user and left_at is null
  ) then
    raise exception 'You are already in a household. Leave it before creating a new one.'
      using errcode = 'P0001';
  end if;

  -- Cooldown after leaving / being removed.
  select eligible_at into v_cooldown
  from public.household_join_cooldowns where user_id = v_user;
  if v_cooldown is not null and v_cooldown > now() then
    raise exception 'You can join or create a household after %.', to_char(v_cooldown, 'YYYY-MM-DD HH24:MI UTC')
      using errcode = 'P0001';
  end if;

  insert into public.households (name, owner_id)
    values (btrim(p_name), v_user)
    returning id into v_id;

  insert into public.household_members (household_id, user_id, role)
    values (v_id, v_user, 'OWNER');

  perform public.record_audit(
    'HOUSEHOLD_CREATED', 'HOUSEHOLD', v_id, v_id,
    jsonb_build_object('name', btrim(p_name))
  );
  return v_id;
end;
$$;
grant execute on function public.create_household(text) to authenticated;

-- ---------- rename_household ----------

create or replace function public.rename_household(p_household_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_old text;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Household name is required.' using errcode = 'P0001';
  end if;
  if char_length(p_name) > 80 then
    raise exception 'Household name is too long.' using errcode = 'P0001';
  end if;
  select name into v_old from public.households where id = p_household_id;
  if v_old is null then
    raise exception 'Household not found.' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.households
    where id = p_household_id and owner_id = v_user
  ) then
    raise exception 'Only the household owner can rename it.' using errcode = '42501';
  end if;

  update public.households set name = btrim(p_name) where id = p_household_id;
  perform public.record_audit(
    'HOUSEHOLD_RENAMED', 'HOUSEHOLD', p_household_id, p_household_id,
    jsonb_build_object('from', v_old, 'to', btrim(p_name))
  );
end;
$$;
grant execute on function public.rename_household(uuid, text) to authenticated;

-- ---------- delete_household ----------
-- The owner can dissolve their household only when they're the sole
-- remaining member. Otherwise they must transfer ownership first.

create or replace function public.delete_household(p_household_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_active int;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.households
    where id = p_household_id and owner_id = v_user
  ) then
    raise exception 'Only the household owner can delete it.' using errcode = '42501';
  end if;
  select count(*) into v_active
  from public.household_members
  where household_id = p_household_id and left_at is null;
  if v_active > 1 then
    raise exception 'Remove all other members before deleting the household.' using errcode = 'P0001';
  end if;

  -- Unshare any collections currently shared into this household before
  -- the household_id FK cascades the row away — keeps the parent
  -- collections intact for the owner.
  update public.recipe_collections
    set shared_with_household_id = null,
        last_share_attested_at = null
    where shared_with_household_id = p_household_id;

  perform public.record_audit(
    'HOUSEHOLD_DELETED', 'HOUSEHOLD', p_household_id, p_household_id, '{}'::jsonb
  );
  delete from public.households where id = p_household_id;
end;
$$;
grant execute on function public.delete_household(uuid) to authenticated;

-- ---------- invite_to_household ----------

create or replace function public.invite_to_household(p_household_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_token text;
  v_active int;
  v_cap int;
  v_open_invites int;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.households
    where id = p_household_id and owner_id = v_user
  ) then
    raise exception 'Only the household owner can issue invites.' using errcode = '42501';
  end if;

  -- Cap pending invites so the owner can't pre-mint 50 tokens, then
  -- have them all accepted in parallel beyond the member cap.
  select count(*) into v_open_invites
  from public.household_invites
  where household_id = p_household_id
    and used_at is null and revoked_at is null
    and expires_at > now();
  if v_open_invites >= 10 then
    raise exception 'Too many open invites. Revoke unused invites first.' using errcode = 'P0001';
  end if;

  select count(*), max_members
    into v_active, v_cap
  from public.household_members hm
  join public.households h on h.id = hm.household_id
  where hm.household_id = p_household_id and hm.left_at is null
  group by h.max_members;
  if v_active >= v_cap then
    raise exception 'Household is full (% of % members).', v_active, v_cap using errcode = 'P0001';
  end if;

  -- pgcrypto lives in the `extensions` schema and isn't on the
  -- security-definer search_path; qualify explicitly.
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.household_invites (household_id, token, created_by, expires_at)
    values (p_household_id, v_token, v_user, now() + interval '7 days');

  perform public.record_audit(
    'MEMBER_INVITED', 'HOUSEHOLD', p_household_id, p_household_id,
    jsonb_build_object('token_prefix', left(v_token, 8))
  );
  return v_token;
end;
$$;
grant execute on function public.invite_to_household(uuid) to authenticated;

-- ---------- revoke_household_invite ----------

create or replace function public.revoke_household_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_household uuid;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select household_id into v_household from public.household_invites where id = p_invite_id;
  if v_household is null then
    raise exception 'Invite not found.' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.households where id = v_household and owner_id = v_user
  ) then
    raise exception 'Only the household owner can revoke invites.' using errcode = '42501';
  end if;
  update public.household_invites
    set revoked_at = now()
    where id = p_invite_id and used_at is null and revoked_at is null;
  perform public.record_audit(
    'INVITE_REVOKED', 'INVITE', p_invite_id, v_household, '{}'::jsonb
  );
end;
$$;
grant execute on function public.revoke_household_invite(uuid) to authenticated;

-- ---------- accept_household_invite ----------
--
-- Returns the joined household_id. Raises on any of:
--   - invalid / expired / used / revoked token
--   - caller already in a household
--   - caller currently in cooldown
--   - household at cap
--   - caller hasn't accepted current ToS
--
-- ToS check is its own dedicated migration; this RPC just calls the
-- guard helper.

create or replace function public.accept_household_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_invite public.household_invites%rowtype;
  v_active int;
  v_cap int;
  v_cooldown timestamptz;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform public.require_current_tos();

  select * into v_invite from public.household_invites where token = p_token;
  if v_invite.id is null then
    raise exception 'Invite not found.' using errcode = 'P0001';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'Invite was revoked.' using errcode = 'P0001';
  end if;
  if v_invite.used_at is not null then
    raise exception 'Invite has already been used.' using errcode = 'P0001';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'Invite has expired.' using errcode = 'P0001';
  end if;

  -- One active household per user.
  if exists (
    select 1 from public.household_members
    where user_id = v_user and left_at is null
  ) then
    raise exception 'You are already in a household. Leave it before joining another.'
      using errcode = 'P0001';
  end if;

  -- Cooldown.
  select eligible_at into v_cooldown
  from public.household_join_cooldowns where user_id = v_user;
  if v_cooldown is not null and v_cooldown > now() then
    raise exception 'You can join a household after %.', to_char(v_cooldown, 'YYYY-MM-DD HH24:MI UTC')
      using errcode = 'P0001';
  end if;

  -- Cap.
  select count(*), max(h.max_members)
    into v_active, v_cap
  from public.household_members hm
  join public.households h on h.id = hm.household_id
  where hm.household_id = v_invite.household_id and hm.left_at is null;
  if v_active >= v_cap then
    raise exception 'Household is full (% of % members).', v_active, v_cap using errcode = 'P0001';
  end if;

  -- Mark invite used, add member, audit.
  update public.household_invites
    set used_at = now(), used_by = v_user
    where id = v_invite.id;

  insert into public.household_members (household_id, user_id, role, attested_tos_version)
    values (v_invite.household_id, v_user, 'MEMBER',
            coalesce((select tos_version from public.profiles where id = v_user), 0));

  perform public.record_audit(
    'MEMBER_JOINED', 'HOUSEHOLD', v_invite.household_id, v_invite.household_id,
    jsonb_build_object('via_invite', v_invite.id)
  );

  return v_invite.household_id;
end;
$$;
grant execute on function public.accept_household_invite(text) to authenticated;

-- ---------- leave_household ----------

create or replace function public.leave_household()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_membership public.household_members%rowtype;
  v_active int;
  v_cooldown_until timestamptz;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_membership
  from public.household_members
  where user_id = v_user and left_at is null;
  if v_membership.id is null then
    raise exception 'You are not currently in a household.' using errcode = 'P0001';
  end if;

  if v_membership.role = 'OWNER' then
    select count(*) into v_active
    from public.household_members
    where household_id = v_membership.household_id and left_at is null;
    if v_active > 1 then
      raise exception 'Transfer ownership before leaving the household.' using errcode = 'P0001';
    end if;
  end if;

  update public.household_members
    set left_at = now()
    where id = v_membership.id;

  v_cooldown_until := now() + (public.household_cooldown_days() || ' days')::interval;
  insert into public.household_join_cooldowns (user_id, eligible_at, reason)
    values (v_user, v_cooldown_until, 'LEFT')
    on conflict (user_id) do update
      set eligible_at = greatest(public.household_join_cooldowns.eligible_at, excluded.eligible_at),
          reason = excluded.reason,
          updated_at = now();

  -- If this was a sole owner leaving (i.e. they were the only member),
  -- garbage-collect the household — leaves no orphan owner_id pointing
  -- at a one-member-zero ghost.
  if v_membership.role = 'OWNER' then
    delete from public.households where id = v_membership.household_id;
  end if;

  perform public.record_audit(
    'MEMBER_LEFT', 'HOUSEHOLD', v_membership.household_id, v_membership.household_id, '{}'::jsonb
  );
end;
$$;
grant execute on function public.leave_household() to authenticated;

-- ---------- remove_member ----------

create or replace function public.remove_household_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_membership public.household_members%rowtype;
  v_household_id uuid;
  v_cooldown_until timestamptz;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_membership
  from public.household_members
  where user_id = p_user_id and left_at is null;
  if v_membership.id is null then
    raise exception 'Member not found in any household.' using errcode = 'P0001';
  end if;

  v_household_id := v_membership.household_id;

  if not exists (
    select 1 from public.households
    where id = v_household_id and owner_id = v_user
  ) then
    raise exception 'Only the household owner can remove members.' using errcode = '42501';
  end if;
  if v_membership.role = 'OWNER' then
    raise exception 'Owner cannot remove themselves; use transfer_household_ownership instead.' using errcode = 'P0001';
  end if;

  update public.household_members
    set left_at = now()
    where id = v_membership.id;

  v_cooldown_until := now() + (public.household_cooldown_days() || ' days')::interval;
  insert into public.household_join_cooldowns (user_id, eligible_at, reason)
    values (p_user_id, v_cooldown_until, 'REMOVED')
    on conflict (user_id) do update
      set eligible_at = greatest(public.household_join_cooldowns.eligible_at, excluded.eligible_at),
          reason = excluded.reason,
          updated_at = now();

  perform public.record_audit(
    'MEMBER_REMOVED', 'HOUSEHOLD', v_household_id, v_household_id,
    jsonb_build_object('removed_user_id', p_user_id)
  );
end;
$$;
grant execute on function public.remove_household_member(uuid) to authenticated;

-- ---------- transfer_household_ownership ----------

create or replace function public.transfer_household_ownership(p_new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_household_id uuid;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select id into v_household_id from public.households where owner_id = v_user;
  if v_household_id is null then
    raise exception 'You do not own a household.' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.household_members
    where household_id = v_household_id and user_id = p_new_owner_id and left_at is null
  ) then
    raise exception 'New owner must be an active member of the household.' using errcode = 'P0001';
  end if;
  if p_new_owner_id = v_user then
    raise exception 'You already own this household.' using errcode = 'P0001';
  end if;

  update public.households set owner_id = p_new_owner_id where id = v_household_id;
  update public.household_members set role = 'MEMBER'
    where household_id = v_household_id and user_id = v_user and left_at is null;
  update public.household_members set role = 'OWNER'
    where household_id = v_household_id and user_id = p_new_owner_id and left_at is null;

  perform public.record_audit(
    'OWNERSHIP_TRANSFERRED', 'HOUSEHOLD', v_household_id, v_household_id,
    jsonb_build_object('from', v_user, 'to', p_new_owner_id)
  );
end;
$$;
grant execute on function public.transfer_household_ownership(uuid) to authenticated;

-- ---------- preview_household_invite ----------
--
-- The acceptance page renders "You're being invited to <household>" before
-- the user accepts. RLS hides invites from non-members, but we want the
-- invitee to see the household name and inviter before committing.
-- security-definer keeps it scoped to a single-row token lookup.

create or replace function public.preview_household_invite(p_token text)
returns table (
  household_id uuid,
  household_name text,
  invited_by_name text,
  expires_at timestamptz,
  revoked boolean,
  used boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    h.id,
    h.name,
    p.display_name,
    i.expires_at,
    (i.revoked_at is not null) as revoked,
    (i.used_at is not null) as used
  from public.household_invites i
  join public.households h on h.id = i.household_id
  left join public.profiles p on p.id = i.created_by
  where i.token = p_token
  limit 1;
$$;
grant execute on function public.preview_household_invite(text) to authenticated, anon;
