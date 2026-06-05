-- Right-to-erasure RPC.
--
-- The Privacy Policy promises in-app account deletion as the GDPR-Art.17
-- erasure / CCPA "delete" implementation. This RPC is the one-call path:
--
--   1. Refuse if the caller still owns a household with other active
--      members. The same guardrail `leave_household` uses — the user
--      must transfer ownership first so the household and its members
--      don't get cascade-deleted out from under everyone else.
--   2. Dissolve sole-owner households (just the user, no other active
--      members) so the cascade doesn't leave behind a one-member
--      ghost.
--   3. Write the final ACCOUNT_DELETED audit row. The audit_log row
--      survives the user's deletion because audit_log.actor_id is
--      `on delete set null` — the row stays, the actor link nulls
--      out. The Privacy Policy explicitly carves audit logs out of
--      erasure on legitimate-interest grounds (defending takedowns,
--      investigating abuse).
--   4. Delete from auth.users. That cascades to public.profiles (FK
--      cascade) which cascades to every user-owned table (collections,
--      recipes, ingredients, instructions, conversion_rules, import
--      tables, cli_tokens, user_ocr_prefs, etc.). RLS on the cascade
--      is bypassed because the trigger fires as the table owner.
--
-- security definer so we can reach into auth.users. The function
-- explicitly checks auth.uid() so a service-role caller can't use it
-- to delete arbitrary accounts — admins should use the moderation
-- path or the auth.admin API.

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_owned_household uuid;
  v_other_active int;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- Refuse if the caller owns a household with other active members.
  select id into v_owned_household
  from public.households
  where owner_id = v_user
  limit 1;

  if v_owned_household is not null then
    select count(*) into v_other_active
    from public.household_members
    where household_id = v_owned_household
      and left_at is null
      and user_id <> v_user;
    if v_other_active > 0 then
      raise exception 'Transfer or remove other household members before deleting your account.'
        using errcode = 'P0001';
    end if;
    -- Sole-owner case: dissolve the household so cascade chains don't
    -- leave behind orphan rows. delete_household would refuse for an
    -- account-deletion context (the household has the caller as the
    -- only active member, so delete_household's own check passes; we
    -- could call it, but inlining keeps the cascade in one tx).
    update public.recipe_collections
      set shared_with_household_id = null,
          last_share_attested_at = null
      where shared_with_household_id = v_owned_household;
    perform public.record_audit(
      'HOUSEHOLD_DELETED', 'HOUSEHOLD', v_owned_household, v_owned_household,
      jsonb_build_object('reason', 'account_deleted')
    );
    delete from public.households where id = v_owned_household;
  end if;

  -- Final audit row. Recorded BEFORE the cascade nulls actor_id —
  -- the row survives (audit_log.actor_id on delete set null) but
  -- the captured user uuid is preserved in metadata for traceability.
  perform public.record_audit(
    'ACCOUNT_DELETED', 'PROFILE', v_user, null,
    jsonb_build_object('user_id', v_user, 'at', now())
  );

  -- Cascade trigger. auth.users → public.profiles via FK cascade →
  -- every user-owned table down the chain.
  delete from auth.users where id = v_user;
end;
$$;

grant execute on function public.delete_my_account() to authenticated;
