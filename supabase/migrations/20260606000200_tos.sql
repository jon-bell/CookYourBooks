-- Terms of Service / Acceptable Use acceptance.
--
-- Every user has a `tos_version` column on their profile. The current
-- version is held by an immutable function (`current_tos_version`) so
-- it's checked into the schema alongside the trigger logic — bumping
-- the version requires a follow-up migration, which keeps the legal
-- record honest.
--
-- Two enforcement points:
--   * `accept_tos(version)` is the only way to set the column (clients
--     can't update profiles.tos_version directly).
--   * `require_current_tos()` is a helper that any state-changing RPC
--     calls before doing work that requires the user to have accepted
--     current terms. Today that's: accepting a household invite,
--     sharing a collection with a household, and publishing a
--     collection. Reading content does not require acceptance — only
--     uploading or sharing does.

create or replace function public.current_tos_version()
returns int language sql immutable as $$ select 1 $$;

alter table public.profiles
  add column tos_version int not null default 0,
  add column tos_accepted_at timestamptz;

-- ---------- accept_tos ----------

create or replace function public.accept_tos(p_version int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_current int := public.current_tos_version();
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_version <> v_current then
    raise exception 'Refusing to accept ToS version % — current version is %.', p_version, v_current
      using errcode = 'P0001';
  end if;
  update public.profiles
    set tos_version = v_current,
        tos_accepted_at = now()
    where id = v_user;
  perform public.record_audit(
    'TOS_ACCEPTED', 'PROFILE', v_user, null,
    jsonb_build_object('version', v_current)
  );
end;
$$;
grant execute on function public.accept_tos(int) to authenticated;

-- ---------- require_current_tos ----------
--
-- Raises if the caller hasn't accepted the current ToS version. RPCs
-- that gate on this call `perform public.require_current_tos();` early.

create or replace function public.require_current_tos()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_version int;
  v_current int := public.current_tos_version();
begin
  -- Seed / admin / migration contexts run with no auth.uid() — they're
  -- the platform itself, not an end user, so the ToS gate doesn't apply.
  -- RPCs that wrap this helper still authorise the caller separately.
  if v_user is null then
    return;
  end if;
  select tos_version into v_version from public.profiles where id = v_user;
  if coalesce(v_version, 0) < v_current then
    -- Distinct error code shape so the frontend can intercept and show
    -- the ToS acceptance dialog instead of the raw text.
    raise exception 'TOS_NOT_ACCEPTED: please accept the current Terms of Service (version %) to continue.', v_current
      using errcode = 'P0001';
  end if;
end;
$$;
grant execute on function public.require_current_tos() to authenticated;
