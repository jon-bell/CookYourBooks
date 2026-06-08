-- Cover-image generation: cost-center wiring + per-user prefs.
--
-- The Gemini cover worker (20260626000100) meters each generation into the
-- existing misc_llm_usage ledger (the same table ISBN / video imports use),
-- so it surfaces on /cost with no view change — llm_usage_report already
-- selects misc_llm_usage.feature verbatim. We only have to widen the feature
-- CHECK to admit 'cover_image'. Per-user model/prompt prefs mirror
-- user_ocr_prefs; the Gemini API key is reused from user_ocr_keys (resolved
-- via ocr_resolve_effective_key) — no new key management.

-- ---------- misc_llm_usage: admit the cover_image feature ----------
alter table public.misc_llm_usage
  drop constraint if exists misc_llm_usage_feature_check;
alter table public.misc_llm_usage
  add constraint misc_llm_usage_feature_check
  check (feature in ('isbn', 'video', 'cover_image'));

-- The record RPC's inline guard also enumerates the allowed features; widen it.
-- (Otherwise the worker's misc_llm_usage_record call raises 'feature must be
-- isbn|video' before the row reaches the table CHECK.) Byte-identical to the
-- 20260625000000 body apart from the feature list.
create or replace function public.misc_llm_usage_record(p_event jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := nullif(p_event->>'owner_id', '')::uuid;
  v_provider text := coalesce(p_event->>'provider', '');
  v_model text := coalesce(p_event->>'model', '');
  v_prompt int := coalesce((p_event->>'prompt_tokens')::int, 0);
  v_completion int := coalesce((p_event->>'completion_tokens')::int, 0);
  v_cost bigint;
  v_rate public.model_pricing%rowtype;
  v_id uuid;
begin
  if v_owner is null then
    raise exception 'owner_id required' using errcode = '22023';
  end if;
  if coalesce(p_event->>'feature', '') not in ('isbn', 'video', 'cover_image') then
    raise exception 'feature must be isbn|video|cover_image' using errcode = '22023';
  end if;

  if p_event ? 'cost_usd_micros' then
    v_cost := coalesce((p_event->>'cost_usd_micros')::bigint, 0);
  else
    select * into v_rate from public.model_pricing
      where provider = v_provider and model = v_model;
    if found then
      v_cost := round(
        v_prompt * v_rate.input_usd_per_mtok
        + v_completion * v_rate.output_usd_per_mtok
      )::bigint;
    else
      v_cost := 0;  -- unknown model: keep the token record, don't fabricate a cost
    end if;
  end if;

  insert into public.misc_llm_usage (
    owner_id, key_owner_id, feature, provider, model,
    prompt_tokens, completion_tokens, cost_usd_micros, latency_ms,
    error_kind, produced_ref, produced_kind
  ) values (
    v_owner,
    nullif(p_event->>'key_owner_id', '')::uuid,
    p_event->>'feature', v_provider, v_model,
    v_prompt, v_completion, v_cost,
    coalesce((p_event->>'latency_ms')::int, 0),
    nullif(p_event->>'error_kind', ''),
    nullif(p_event->>'produced_ref', ''),
    nullif(p_event->>'produced_kind', '')
  ) returning id into v_id;
  return v_id;
end;
$$;

-- ---------- model_pricing seed for the image model ----------
-- The worker also refreshes model_pricing from pricing.json on its first run
-- (source 'bundled'), but seed it here so misc_llm_usage_record's server-side
-- cost path works immediately. Rates are per-Mtok estimates (image output
-- bills ~1290 tokens/image); refresh from models.dev keeps them honest.
insert into public.model_pricing (provider, model, input_usd_per_mtok, output_usd_per_mtok, source)
  values ('gemini', 'gemini-3.1-flash-image', 0.30, 30.00, 'bundled')
  on conflict (provider, model) do nothing;

-- ---------- user_cover_prefs (mirrors user_ocr_prefs) ----------
create table public.user_cover_prefs (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'gemini'
    check (provider in ('gemini')),
  model text not null default 'gemini-3.1-flash-image',
  prompt text not null default 'A thumbnail to put on a recipe card for this recipe, RECIPE NAME. Ingredients <INGREDIENTS>. Instructions <INSTRUCTIONS>',
  updated_at timestamptz not null default now()
);

alter table public.user_cover_prefs enable row level security;

create policy "user_cover_prefs_read_own" on public.user_cover_prefs
  for select using ((select auth.uid()) = owner_id);
create policy "user_cover_prefs_upsert_own" on public.user_cover_prefs
  for insert with check ((select auth.uid()) = owner_id);
create policy "user_cover_prefs_update_own" on public.user_cover_prefs
  for update using ((select auth.uid()) = owner_id);

create or replace function public.user_cover_prefs_set(
  p_model text,
  p_prompt text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'Not authenticated';
  end if;
  insert into public.user_cover_prefs (owner_id, model, prompt, updated_at)
    values (caller, coalesce(nullif(p_model, ''), 'gemini-3.1-flash-image'), p_prompt, now())
    on conflict (owner_id) do update set
      model = excluded.model,
      prompt = excluded.prompt,
      updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.user_cover_prefs_set(text, text) from public, anon;
grant execute on function public.user_cover_prefs_set(text, text) to authenticated;
