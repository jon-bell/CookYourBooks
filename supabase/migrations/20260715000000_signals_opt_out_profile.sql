-- Move the interaction-signal opt-out from per-device localStorage onto the
-- account, and make it authoritative server-side.
--
-- 20260714000000 shipped the opt-out as a localStorage flag, which meant a user
-- who switched it off on their phone was still being recorded from their
-- laptop. A privacy control that only binds the device you happened to set it
-- on isn't really a control, so it belongs on the account.
--
-- Two halves, and the second is the one that matters:
--   1. `profiles.share_interaction_signals` — the synced preference.
--   2. Both write RPCs now READ that column and drop the batch when it's
--      false. Without this the column would just be a shared UI default that
--      any stale tab, cached bundle, or hand-rolled client could ignore. With
--      it, "off" is enforced at the only place rows can be created.

-- ============================================================
-- 1. the column
-- ============================================================
-- Default true = capture on, matching the shipped behaviour, so this is not a
-- silent change of state for existing users.
--
-- NOTE ON VISIBILITY: `profiles` carries a `profiles_public_read` policy of
-- `using (true)` (20260419000100), so this boolean is world-readable like
-- `display_name`, `tos_version`, and `disabled` already are. That is a
-- deliberate accept, not an oversight: the flag says only whether someone
-- helps improve ranking. Everything actually sensitive — the query text, the
-- corrections — lives in search_events / suggestion_events, which are
-- owner-only with no household branch (20260714000000).
alter table public.profiles
  add column if not exists share_interaction_signals boolean not null default true;

comment on column public.profiles.share_interaction_signals is
  'User preference: record interaction signals (searches, result opens, suggestion '
  'accept/correct) for product improvement and model training. Enforced by '
  'record_search_events / record_suggestion_events, which drop the batch when false.';

-- ============================================================
-- 2. enforcement helper
-- ============================================================
-- Fails CLOSED: no profile row means we don't know the user's preference, so
-- we don't record. A missing profile is a degenerate state (handle_new_user
-- creates one at signup), and dropping a signal costs nothing — whereas
-- recording against an unknown preference is exactly the mistake this
-- migration exists to prevent.
create or replace function public.signals_enabled_for(p_owner uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.share_interaction_signals from public.profiles p where p.id = p_owner),
    false
  );
$$;
revoke all on function public.signals_enabled_for(uuid) from public, anon, authenticated;

-- ============================================================
-- 3. re-emit both write RPCs with the preference check
-- ============================================================
-- Bodies are 20260714000000's verbatim, plus the early return. The check sits
-- after the auth guard and before the loop, so an opted-out caller costs one
-- indexed PK lookup and writes nothing.

create or replace function public.record_search_events(p_events jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_event jsonb;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  -- Opted out on ANY device: the account setting wins over whatever this
  -- client believes. Silent no-op rather than an error — a stale tab flushing
  -- its buffer after the user opted out elsewhere is expected, not exceptional.
  if not public.signals_enabled_for(v_owner) then
    return;
  end if;
  -- Tolerate a NULL / non-array payload as "nothing to record".
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return;
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    -- A row without a query_id can't be joined to anything, so it has no
    -- training value; skip rather than minting a synthetic id that would look
    -- like a real orphan later.
    continue when (v_event->>'query_id') is null;

    insert into public.search_events (
      owner_id, query_id, kind,
      query, mode, result_count, truncated,
      embedder_status, embedded_count, source_filter,
      opened_recipe_id, opened_rank, opened_score
    ) values (
      v_owner,
      (v_event->>'query_id')::uuid,
      coalesce(v_event->>'kind', 'query'),
      coalesce(v_event->>'query', ''),
      coalesce(v_event->>'mode', ''),
      coalesce((v_event->>'result_count')::integer, 0),
      coalesce((v_event->>'truncated')::boolean, false),
      coalesce(v_event->>'embedder_status', ''),
      coalesce((v_event->>'embedded_count')::integer, 0),
      coalesce(v_event->>'source_filter', ''),
      (v_event->>'opened_recipe_id')::uuid,
      (v_event->>'opened_rank')::integer,
      (v_event->>'opened_score')::real
    );
  end loop;
end;
$$;
revoke all on function public.record_search_events(jsonb) from public, anon;
grant execute on function public.record_search_events(jsonb) to authenticated;

create or replace function public.record_suggestion_events(p_events jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_event jsonb;
  v_candidates jsonb;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not public.signals_enabled_for(v_owner) then
    return;
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return;
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    continue when (v_event->>'surface') is null or (v_event->>'action') is null;

    -- The column is `jsonb not null default '[]'`; a client that sends an
    -- object or a scalar would otherwise store something no consumer expects.
    v_candidates := v_event->'candidates';
    if v_candidates is null or jsonb_typeof(v_candidates) <> 'array' then
      v_candidates := '[]'::jsonb;
    end if;

    insert into public.suggestion_events (
      owner_id, surface, action, input_text,
      suggested_key, chosen_key, chosen_rank, candidates
    ) values (
      v_owner,
      v_event->>'surface',
      v_event->>'action',
      coalesce(v_event->>'input_text', ''),
      coalesce(v_event->>'suggested_key', ''),
      coalesce(v_event->>'chosen_key', ''),
      (v_event->>'chosen_rank')::integer,
      v_candidates
    );
  end loop;
end;
$$;
revoke all on function public.record_suggestion_events(jsonb) from public, anon;
grant execute on function public.record_suggestion_events(jsonb) to authenticated;
