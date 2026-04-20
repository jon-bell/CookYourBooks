-- Moderation infrastructure for the public "table of contents" surface.
--
-- Four moving parts:
--   1. `admins` — simple membership table. One admin is bootstrapped via the
--      seed file; additional admins are promoted by existing ones.
--   2. `reports` — user-submitted flags against public collections (and,
--      in future, recipes / users). Admins see everyone's reports; reporters
--      only see their own.
--   3. `moderation_actions` — append-only audit log. Every takedown, ban,
--      and dismiss emits a row here, keyed to the admin who did it.
--   4. `profiles.disabled` — a banned user can still sign in and export
--      their data, but their collections never resurface in Discover and
--      the publishing trigger refuses fresh `is_public = true` writes.

-- ---------- Admins ----------

create table public.admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references public.profiles(id) on delete set null,
  note text
);

-- `is_admin` is security definer so RLS-protected callers (policies,
-- triggers) can read the admins table without punching a hole in its own
-- policies. Marked STABLE so the planner can fold repeat calls.
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = uid);
$$;

grant execute on function public.is_admin(uuid) to authenticated, anon;

alter table public.admins enable row level security;

create policy "admins_self_or_admin_read" on public.admins
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));
create policy "admins_only_admin_write" on public.admins
  for insert with check (public.is_admin(auth.uid()));
create policy "admins_only_admin_delete" on public.admins
  for delete using (public.is_admin(auth.uid()));

-- ---------- Profiles: disabled flag ----------

alter table public.profiles
  add column disabled boolean not null default false,
  add column disabled_reason text;

-- ---------- Reports ----------

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.profiles(id) on delete set null,
  target_type text not null check (target_type in ('COLLECTION', 'RECIPE', 'USER')),
  target_id uuid not null,
  reason text not null check (reason in ('SPAM', 'OFF_TOPIC', 'OFFENSIVE', 'COPYRIGHT', 'OTHER')),
  message text,
  status text not null default 'OPEN' check (status in ('OPEN', 'ACTIONED', 'DISMISSED')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null
);

create index reports_status_idx on public.reports(status, created_at desc);
create index reports_target_idx on public.reports(target_type, target_id);

alter table public.reports enable row level security;

create policy "reports_insert_own" on public.reports
  for insert with check (reporter_id = auth.uid());
create policy "reports_read_own_or_admin" on public.reports
  for select using (reporter_id = auth.uid() or public.is_admin(auth.uid()));
create policy "reports_update_admin" on public.reports
  for update using (public.is_admin(auth.uid()));

-- ---------- Moderation actions (audit log) ----------

create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.profiles(id) on delete set null,
  action text not null check (
    action in (
      'UNPUBLISH', 'REPUBLISH',
      'BAN_USER', 'UNBAN_USER',
      'DISMISS_REPORT', 'GRANT_ADMIN', 'REVOKE_ADMIN'
    )
  ),
  target_type text not null check (target_type in ('COLLECTION', 'RECIPE', 'USER', 'REPORT')),
  target_id uuid not null,
  reason text,
  created_at timestamptz not null default now()
);

create index mod_actions_created_idx on public.moderation_actions(created_at desc);

alter table public.moderation_actions enable row level security;

create policy "mod_actions_read_admin" on public.moderation_actions
  for select using (public.is_admin(auth.uid()));
create policy "mod_actions_insert_admin" on public.moderation_actions
  for insert with check (public.is_admin(auth.uid()) and admin_id = auth.uid());
-- No update or delete policies — append-only by design.

-- ---------- Extended RLS on existing tables ----------

-- Admins need write access to any user's collection to perform takedowns
-- directly. The existing `collections_update_own` policy already covers
-- the owner; this adds an orthogonal admin grant.
create policy "collections_admin_all" on public.recipe_collections
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- Admins also need to update profiles when banning.
create policy "profiles_admin_update" on public.profiles
  for update using (public.is_admin(auth.uid()));

-- ---------- Publishing guard ----------

-- Even if a client tries to flip `is_public = true` on a disabled owner,
-- refuse the write at the database level. Keeps the policy simple: the
-- app can present a friendly error, the DB never exposes banned users.
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
  end if;
  return new;
end;
$$;

create trigger enforce_publishing_before_insupd
  before insert or update of is_public on public.recipe_collections
  for each row execute function public.enforce_publishing_rules();

-- ---------- public_collections view — exclude banned owners ----------

drop view if exists public.public_collections;
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
  group by rc.id, p.display_name;

-- ---------- Admin RPCs ----------
-- Each of these is a single atomic transaction that changes state AND
-- writes the audit row, so every takedown is always recoverable and
-- every ban is always explained.

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
    set is_public = false
    where id = target_collection_id;
  insert into public.moderation_actions (admin_id, action, target_type, target_id, reason)
    values (auth.uid(), 'UNPUBLISH', 'COLLECTION', target_collection_id, reason);
  update public.reports
    set status = 'ACTIONED', resolved_at = now(), resolved_by = auth.uid()
    where target_type = 'COLLECTION' and target_id = target_collection_id and status = 'OPEN';
end;
$$;
grant execute on function public.moderation_unpublish_collection(uuid, text) to authenticated;

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
    set is_public = true
    where id = target_collection_id;
  insert into public.moderation_actions (admin_id, action, target_type, target_id, reason)
    values (auth.uid(), 'REPUBLISH', 'COLLECTION', target_collection_id, reason);
end;
$$;
grant execute on function public.moderation_republish_collection(uuid, text) to authenticated;

create or replace function public.moderation_ban_user(
  target_user_id uuid,
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
  update public.profiles
    set disabled = true, disabled_reason = reason
    where id = target_user_id;
  update public.recipe_collections
    set is_public = false
    where owner_id = target_user_id and is_public = true;
  insert into public.moderation_actions (admin_id, action, target_type, target_id, reason)
    values (auth.uid(), 'BAN_USER', 'USER', target_user_id, reason);
  update public.reports
    set status = 'ACTIONED', resolved_at = now(), resolved_by = auth.uid()
    where status = 'OPEN'
      and (
        (target_type = 'USER' and target_id = target_user_id)
        or (target_type = 'COLLECTION' and target_id in (
          select id from public.recipe_collections where owner_id = target_user_id
        ))
      );
end;
$$;
grant execute on function public.moderation_ban_user(uuid, text) to authenticated;

create or replace function public.moderation_unban_user(
  target_user_id uuid,
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
  update public.profiles
    set disabled = false, disabled_reason = null
    where id = target_user_id;
  insert into public.moderation_actions (admin_id, action, target_type, target_id, reason)
    values (auth.uid(), 'UNBAN_USER', 'USER', target_user_id, reason);
end;
$$;
grant execute on function public.moderation_unban_user(uuid, text) to authenticated;

create or replace function public.moderation_dismiss_report(
  target_report_id uuid,
  note text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  update public.reports
    set status = 'DISMISSED', resolved_at = now(), resolved_by = auth.uid()
    where id = target_report_id;
  insert into public.moderation_actions (admin_id, action, target_type, target_id, reason)
    values (auth.uid(), 'DISMISS_REPORT', 'REPORT', target_report_id, note);
end;
$$;
grant execute on function public.moderation_dismiss_report(uuid, text) to authenticated;

-- Granting admin to another user. Self-service bootstrapping isn't
-- allowed — the seed (or a direct DB intervention) must create the first
-- admin.
create or replace function public.moderation_grant_admin(
  target_user_id uuid,
  note text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  insert into public.admins (user_id, granted_by, note)
    values (target_user_id, auth.uid(), note)
    on conflict (user_id) do update set granted_by = excluded.granted_by, note = excluded.note;
  insert into public.moderation_actions (admin_id, action, target_type, target_id, reason)
    values (auth.uid(), 'GRANT_ADMIN', 'USER', target_user_id, note);
end;
$$;
grant execute on function public.moderation_grant_admin(uuid, text) to authenticated;

create or replace function public.moderation_revoke_admin(
  target_user_id uuid,
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
  delete from public.admins where user_id = target_user_id;
  insert into public.moderation_actions (admin_id, action, target_type, target_id, reason)
    values (auth.uid(), 'REVOKE_ADMIN', 'USER', target_user_id, reason);
end;
$$;
grant execute on function public.moderation_revoke_admin(uuid, text) to authenticated;
