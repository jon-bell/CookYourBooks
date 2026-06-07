-- Accrue token/cost onto import_items in import_fail, like import_complete.
--
-- import_fail recorded per-attempt cost into import_item_attempts but its
-- update of import_items omitted prompt_tokens / completion_tokens /
-- cost_usd_micros. So a failed attempt (terminal failure, or a RECITATION
-- attempt that still burned tokens before a fallback) had its cost dropped
-- from the item — and therefore the batch total under-counted. import_complete
-- already accrues (20260522000000:373-375); mirror it here so the item total
-- is the true sum of all attempts.

create or replace function public.import_fail(
  p_item_id uuid,
  p_claim_token text,
  p_attempt jsonb,
  p_next_state text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  next_attempt int;
  item_owner uuid;
begin
  if p_next_state not in ('PENDING', 'NEEDS_FALLBACK', 'OCR_FAILED') then
    raise exception 'Invalid next state %', p_next_state using errcode = '22023';
  end if;

  select owner_id into item_owner
    from public.import_items
    where id = p_item_id and claim_token = p_claim_token;
  if item_owner is null then
    return false;
  end if;

  select coalesce(max(attempt_no), 0) + 1
    into next_attempt
    from public.import_item_attempts
    where item_id = p_item_id;

  insert into public.import_item_attempts (
    item_id, owner_id, attempt_no,
    provider, model, raw_response_path,
    error_kind, error_message,
    prompt_tokens, completion_tokens, cost_usd_micros, latency_ms,
    started_at, finished_at
  ) values (
    p_item_id, item_owner, next_attempt,
    coalesce(p_attempt->>'provider', ''),
    coalesce(p_attempt->>'model', ''),
    p_attempt->>'raw_response_path',
    coalesce(p_attempt->>'error_kind', 'OTHER'),
    p_attempt->>'error_message',
    coalesce((p_attempt->>'prompt_tokens')::int, 0),
    coalesce((p_attempt->>'completion_tokens')::int, 0),
    coalesce((p_attempt->>'cost_usd_micros')::bigint, 0),
    coalesce((p_attempt->>'latency_ms')::int, 0),
    coalesce((p_attempt->>'started_at')::timestamptz, now()),
    coalesce((p_attempt->>'finished_at')::timestamptz, now())
  );

  update public.import_items
    set status = p_next_state,
        attempts = attempts + 1,
        -- Accrue usage even on failed attempts (they still cost money).
        prompt_tokens = prompt_tokens + coalesce((p_attempt->>'prompt_tokens')::int, 0),
        completion_tokens = completion_tokens + coalesce((p_attempt->>'completion_tokens')::int, 0),
        cost_usd_micros = cost_usd_micros + coalesce((p_attempt->>'cost_usd_micros')::bigint, 0),
        last_error = p_attempt->>'error_message',
        claim_token = null,
        needs_fallback = case
          when p_next_state = 'NEEDS_FALLBACK' then true
          when p_next_state = 'OCR_FAILED' then false
          else needs_fallback
        end
    where id = p_item_id;

  return true;
end;
$$;

revoke all on function public.import_fail(uuid, text, jsonb, text) from public, authenticated, anon;
grant execute on function public.import_fail(uuid, text, jsonb, text) to service_role;
