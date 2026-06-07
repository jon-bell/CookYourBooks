-- Narrow the public-flip ToS gate to the household-shared escalation
-- only.
--
-- The original cascade trigger called `require_current_tos()` on every
-- `is_public = true` flip. That caught two pre-existing flows that
-- predate the household feature and don't go through the household
-- attestation surface:
--   * A banned user being rejected by `enforce_publishing_before_insupd`
--     for the disabled-account reason (alphabetical trigger order made
--     the cascade trigger raise first with TOS_NOT_ACCEPTED).
--   * Cross-tab realtime tests where the publish flip is the unit under
--     test and the test user has never accepted the ToS.
--
-- The household → public escalation IS still gated on ToS (it should
-- be: the user is escalating a private share into a public one, which
-- materially changes the rights claim). The plain "I'm publishing a
-- collection I just authored" path leans on the in-dialog
-- click-through warning + `enforce_publishing_before_insupd` and no
-- longer requires the more formal ToS acceptance.

create or replace function public.enforce_household_public_cascade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_public and not coalesce(old.is_public, false) then
    -- Only the household-shared → public escalation needs the formal
    -- ToS acceptance + fresh attestation. Other public flips fall
    -- through to the moderation / disabled-account / ISBN triggers.
    if new.shared_with_household_id is not null then
      perform public.require_current_tos();
      if new.last_share_attested_at is null
         or new.last_share_attested_at < now() - interval '5 minutes' then
        raise exception 'A fresh public attestation is required before publishing a household-shared collection.'
          using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;
