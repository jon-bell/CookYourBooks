-- Append-only audit log.
--
-- Every household / sharing / attestation / ToS action writes a row
-- here. It's the evidence trail the DMCA process needs ("can you prove
-- the user attested at the time of share?") and the legal-defensibility
-- spine of the household feature ("here is a complete history of who
-- joined, who shared what, and what they attested to").
--
-- The table is INSERT-only at the policy level: no UPDATE or DELETE
-- policies exist, and even admins can only read. If a row needs to be
-- rectified, the rectification goes in as a *new* row of action
-- AUDIT_CORRECTION pointing at the original — the original is never
-- mutated.

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  household_id uuid references public.households(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_actor_idx on public.audit_log(actor_id, created_at desc);
create index audit_log_household_idx on public.audit_log(household_id, created_at desc);
create index audit_log_target_idx on public.audit_log(target_type, target_id, created_at desc);
create index audit_log_action_idx on public.audit_log(action, created_at desc);

alter table public.audit_log enable row level security;

-- Visibility:
--   * Actor reads their own actions (so the user can audit themselves
--     in /settings).
--   * Active household members read household-scoped rows (so the
--     household page can show who joined / shared what).
--   * Admins read everything for moderation.
create policy "audit_self_read" on public.audit_log
  for select using (
    actor_id = auth.uid()
    or (household_id is not null and public.is_household_member(household_id, auth.uid()))
    or public.is_admin(auth.uid())
  );
-- No INSERT / UPDATE / DELETE policies — only the security-definer
-- `record_audit` helper writes here.

-- ---------- record_audit ----------
--
-- All RPCs call this helper. SECURITY DEFINER so the caller doesn't
-- need direct insert privileges; the helper sets actor_id from
-- auth.uid() rather than trusting an argument, so a malicious caller
-- can't forge a row attributed to someone else.

create or replace function public.record_audit(
  p_action text,
  p_target_type text,
  p_target_id uuid,
  p_household_id uuid,
  p_metadata jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log
    (actor_id, action, target_type, target_id, household_id, metadata)
    values
    (auth.uid(), p_action, p_target_type, p_target_id, p_household_id,
     coalesce(p_metadata, '{}'::jsonb));
end;
$$;
-- Not granted to clients — only callable from inside other security-definer
-- functions (which themselves enforce the relevant authorization).
revoke all on function public.record_audit(text, text, uuid, uuid, jsonb) from public;

-- ---------- realtime ----------
alter publication supabase_realtime add table public.audit_log;
