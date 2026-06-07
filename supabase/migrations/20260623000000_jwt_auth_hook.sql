-- Custom access token hook: bake auth context into the JWT.
--
-- WHY: the hot pull tables' RLS resolves household membership via a
-- household_members self-join subquery and admin via an admins lookup.
-- Even hoisted to an InitPlan, that's table access inside the policy on
-- every read of the busiest tables. JWT claims are constant for the whole
-- connection, so reading them in RLS is a pure value compare — the most
-- "evaluated once per query" form there is. This hook stamps:
--   * household_id : the caller's active household (null if none)
--   * is_admin     : whether the caller is in public.admins
-- so the read policies (next migrations) become claim-vs-column compares
-- with NO household_members / admins access at all.
--
-- The viewer claim is membership only (which household the caller is in) —
-- sharing-agnostic. Whether an OWNER shares their library is encoded in
-- each row's denormalized household_id (20260623000100), so the household
-- read branch stays a pure compare without a per-co-member sharing lookup.
--
-- PROPAGATION: claims are minted at sign-in and on token refresh. A user
-- who changes household must refresh so the new claim takes effect — the
-- frontend calls supabase.auth.refreshSession() after the membership RPCs
-- (create/accept/leave/delete household). Cross-user changes (being
-- removed by an owner, admin grant/revoke) can't force the affected user's
-- refresh, so they take effect on that user's next refresh (≤ jwt_expiry,
-- 3600s, auto-refreshed by supabase-js).

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims  jsonb := event -> 'claims';
  v_user  uuid  := (event ->> 'user_id')::uuid;
  v_hh    uuid;
  v_admin boolean;
begin
  -- Active membership: the partial unique index
  -- household_members_one_active_per_user guarantees at most one row.
  select household_id into v_hh
    from public.household_members
   where user_id = v_user and left_at is null
   limit 1;

  if v_hh is not null then
    claims := jsonb_set(claims, '{household_id}', to_jsonb(v_hh::text));
  else
    -- Strip a stale claim (e.g. on the refresh that follows leaving).
    claims := claims - 'household_id';
  end if;

  select exists (select 1 from public.admins a where a.user_id = v_user)
    into v_admin;
  claims := jsonb_set(claims, '{is_admin}', to_jsonb(coalesce(v_admin, false)));

  return jsonb_build_object('claims', claims);
end;
$$;

-- GoTrue invokes the hook as supabase_auth_admin. The function is
-- SECURITY DEFINER (owned by postgres) so its reads see through RLS on
-- household_members / admins; the role only needs EXECUTE. Keep it off
-- the data roles so it can't be called from a client session.
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;

-- Defensive: if the hook is ever switched to SECURITY INVOKER, these keep
-- it working (harmless under SECURITY DEFINER).
grant usage on schema public to supabase_auth_admin;
grant select on public.household_members, public.admins to supabase_auth_admin;
