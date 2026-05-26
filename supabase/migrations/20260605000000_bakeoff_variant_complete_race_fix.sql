-- Fix a concurrency race in import_variant_complete / import_variant_fail.
--
-- When the worker processes a bakeoff item's variants in parallel
-- (PARALLEL=3 by default), two variant_complete calls can land in
-- separate Postgres transactions concurrently. Each one:
--
--   1. UPDATEs its own variant_result row to DONE
--   2. SELECTs the count of PENDING/CLAIMED rows for that item
--   3. If pending = 0, flips import_items.status to BAKEOFF_READY
--
-- Under READ COMMITTED isolation the SELECT in step 2 only sees rows
-- committed *before* the snapshot started. So when both transactions
-- start at roughly the same wall-clock, transaction A sees its own
-- update applied (variant1=DONE) but B's update still pre-commit
-- (variant2=CLAIMED) — counts pending=1. B sees the symmetric view —
-- also pending=1. Neither flips the item, and the page sits on
-- "Running variants" forever.
--
-- Fix: lock the parent import_items row at the *start* of the
-- function (SELECT … FOR UPDATE). The first variant_complete grabs
-- the row lock; the second blocks until the first commits, then sees
-- the freshly-updated variant_result and counts pending=0 correctly.

create or replace function public.import_variant_complete(
  p_result_id uuid,
  p_claim_token text,
  p_payload jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid;
  pending int;
  failed int;
  total int;
begin
  -- Find the parent item id and grab a row lock before doing anything.
  -- The lock serialises concurrent variant_complete/fail calls for
  -- the same item so the count check in step 2 is consistent.
  select item_id into v_item_id
    from public.import_item_variant_results
    where id = p_result_id and claim_token = p_claim_token;
  if v_item_id is null then
    return false;
  end if;
  perform 1 from public.import_items where id = v_item_id for update;

  update public.import_item_variant_results set
    status = 'DONE',
    drafts = p_payload->'drafts',
    raw_text = p_payload->>'raw_text',
    prompt_tokens = nullif((p_payload->>'prompt_tokens')::int, 0),
    completion_tokens = nullif((p_payload->>'completion_tokens')::int, 0),
    cost_usd_micros = (p_payload->>'cost_usd_micros')::int,
    latency_ms = (p_payload->>'latency_ms')::int,
    error_kind = 'OK',
    error_message = null,
    claim_token = null,
    updated_at = now()
    where id = p_result_id and claim_token = p_claim_token;
  if not found then
    return false;
  end if;

  select
    count(*) filter (where status in ('PENDING', 'CLAIMED')),
    count(*) filter (where status = 'FAILED'),
    count(*)
    into pending, failed, total
    from public.import_item_variant_results
   where item_id = v_item_id;

  if pending = 0 and total > 0 then
    update public.import_items set
      status = case when failed = total then 'OCR_FAILED' else 'BAKEOFF_READY' end,
      updated_at = now()
      where id = v_item_id and status = 'BAKEOFF_PENDING';
  end if;

  return true;
end;
$$;

revoke all on function public.import_variant_complete(uuid, text, jsonb)
  from public, authenticated, anon;
grant execute on function public.import_variant_complete(uuid, text, jsonb) to service_role;

create or replace function public.import_variant_fail(
  p_result_id uuid,
  p_claim_token text,
  p_error_kind text,
  p_error_message text,
  p_latency_ms int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid;
  pending int;
  failed int;
  total int;
begin
  select item_id into v_item_id
    from public.import_item_variant_results
    where id = p_result_id and claim_token = p_claim_token;
  if v_item_id is null then
    return false;
  end if;
  perform 1 from public.import_items where id = v_item_id for update;

  update public.import_item_variant_results set
    status = 'FAILED',
    error_kind = p_error_kind,
    error_message = p_error_message,
    latency_ms = p_latency_ms,
    claim_token = null,
    updated_at = now()
    where id = p_result_id and claim_token = p_claim_token;
  if not found then
    return false;
  end if;

  select
    count(*) filter (where status in ('PENDING', 'CLAIMED')),
    count(*) filter (where status = 'FAILED'),
    count(*)
    into pending, failed, total
    from public.import_item_variant_results
   where item_id = v_item_id;

  if pending = 0 and total > 0 then
    update public.import_items set
      status = case when failed = total then 'OCR_FAILED' else 'BAKEOFF_READY' end,
      updated_at = now()
      where id = v_item_id and status = 'BAKEOFF_PENDING';
  end if;

  return true;
end;
$$;

revoke all on function public.import_variant_fail(uuid, text, text, text, int)
  from public, authenticated, anon;
grant execute on function public.import_variant_fail(uuid, text, text, text, int) to service_role;
