-- Household sharing.
--
-- A household is a small group (≤ 6 members) within which a user can
-- share recipe collections that they wouldn't be comfortable making
-- publicly visible — typically content scanned from cookbooks they own.
-- Household sharing sits in a different legal posture from public
-- publishing: it mirrors what a real family does with the cookbooks on
-- their shelf, and matches the household-scope carveouts in the
-- Copyright Act (§101 defines "public performance" as outside the
-- "normal circle of a family and its social acquaintances") and the
-- industry norm set by Apple Family / Spotify Family / Kindle Family.
--
-- Hard guardrails enforced at the DB so a hand-crafted client can't
-- weaponize "household" as a back-door to broader sharing:
--   * ≤ 6 active members per household
--   * exactly one active household per user
--   * 7-day cooldown after leaving / being removed before re-joining
--     anywhere (prevents content-grab churn)
--   * owner cannot leave a household with other active members —
--     must transfer ownership first
--   * member add path goes through `accept_household_invite` only;
--     direct INSERTs from `authenticated` are blocked by RLS

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  max_members int not null default 6 check (max_members between 2 and 6),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index households_owner_idx on public.households(owner_id);

alter table public.households enable row level security;

create trigger households_updated
  before update on public.households
  for each row execute function public.touch_updated_at();

-- ---------- household_members ----------

create table public.household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'MEMBER' check (role in ('OWNER', 'MEMBER')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  attested_tos_version int not null default 0,
  updated_at timestamptz not null default now()
);

create index household_members_household_idx on public.household_members(household_id);
create index household_members_user_idx on public.household_members(user_id);

-- Enforce "one active household per user" via a partial unique index on
-- active rows (left_at is null). Past memberships stay around in the
-- table for audit purposes — we never delete a row, we only flip
-- left_at.
create unique index household_members_one_active_per_user
  on public.household_members(user_id)
  where left_at is null;

create trigger household_members_updated
  before update on public.household_members
  for each row execute function public.touch_updated_at();

alter table public.household_members enable row level security;

-- ---------- cooldown ledger ----------
--
-- When a user leaves or is removed, they get a 7-day cooldown before
-- they can be added to any household. Stored as a row per user with the
-- `eligible_at` floor; the accept_household_invite RPC consults this
-- before letting the new member through.

create table public.household_join_cooldowns (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  eligible_at timestamptz not null,
  reason text,
  updated_at timestamptz not null default now()
);

alter table public.household_join_cooldowns enable row level security;

create policy "cooldowns_self_read" on public.household_join_cooldowns
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));
-- No insert / update / delete policies — only security-definer RPCs touch this.

-- ---------- helpers (security definer) ----------

-- `is_household_member` lets RLS policies on other tables (recipes,
-- ingredients, etc.) ask "is the caller in this household?" without
-- punching a hole in household_members' own policies. Marked STABLE so
-- the planner can fold repeat calls within a single query.
create or replace function public.is_household_member(p_household_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members
    where household_id = p_household_id
      and user_id = p_user_id
      and left_at is null
  );
$$;

grant execute on function public.is_household_member(uuid, uuid) to authenticated, anon;

-- Returns the user's active household_id (null if not in one). Convenient
-- for RLS policies that need a "shared into MY household" check.
create or replace function public.current_household_id(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from public.household_members
  where user_id = p_user_id and left_at is null
  limit 1;
$$;

grant execute on function public.current_household_id(uuid) to authenticated, anon;

-- ---------- household_members RLS ----------
--
-- Members can see the membership list of their own household so the
-- /household page can render. INSERT / UPDATE / DELETE go through
-- security-definer RPCs (next migration) — no direct write policies.

create policy "household_members_read_same_household" on public.household_members
  for select using (
    -- See your own row even if you've left (history)
    user_id = auth.uid()
    -- See active rows in the household you're currently active in
    or public.is_household_member(household_id, auth.uid())
    -- Admins see all for moderation
    or public.is_admin(auth.uid())
  );

-- ---------- households RLS ----------

create policy "households_read_member" on public.households
  for select using (
    public.is_household_member(id, auth.uid())
    or public.is_admin(auth.uid())
  );

-- Only the owner can update household-level settings (name, max_members).
create policy "households_owner_update" on public.households
  for update using (
    owner_id = auth.uid() or public.is_admin(auth.uid())
  );

-- No direct INSERT policy — `create_household` RPC is the only path.
-- No direct DELETE policy — `delete_household` RPC is the only path.

-- ---------- realtime ----------
-- Members need to see each other's joins/leaves in real time so the
-- /household page is live. Realtime respects RLS, so a non-member
-- never gets these events.
alter publication supabase_realtime add table public.households;
alter publication supabase_realtime add table public.household_members;
