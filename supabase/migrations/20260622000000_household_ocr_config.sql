-- Shared household OCR config + key borrowing.
--
-- Lets a household member who hasn't set up their own OCR run bulk imports
-- using a household-mate's provider/model/prompt/fallback AND API key. The
-- owner controls it. The config row holds NO secret — only a key_owner_id
-- pointer; the API key stays in Vault, reachable only through the
-- service-role resolver below (mirrors user_ocr_keys / ocr_resolve_key).
--
-- Resolution rule (both client batch-creation and worker key lookup): the
-- member's own config/key wins; else the enabled household config/key.

-- ---------- household_ocr_config ----------
-- Dedicated 1:1 table rather than columns on `households`: households is in
-- the supabase_realtime publication and meant to stay minimal, and this row
-- simply doesn't exist until the owner sets it up.
create table public.household_ocr_config (
  household_id uuid primary key references public.households(id) on delete cascade,
  ocr_share_enabled boolean not null default false,
  provider text not null default 'gemini'
    check (provider in ('gemini', 'openai-compatible')),
  model text not null default '',
  prompt text,                          -- null => worker uses built-in RECIPE_PROMPT
  fallback_provider text
    check (fallback_provider in ('gemini', 'openai-compatible')),
  fallback_model text,
  -- The member whose Vault key the household borrows. Defaults to the owner
  -- at creation; must be an ACTIVE member (enforced in the write RPC, since
  -- an FK can't see household_members.left_at).
  key_owner_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.household_ocr_config enable row level security;

create trigger household_ocr_config_updated
  before update on public.household_ocr_config
  for each row execute function public.touch_updated_at();

-- Active members (+ admins) may READ the config. The row carries no secret,
-- so member read is safe (it exposes whose key is shared, which is intended
-- transparency, not a leak). Tiny PK-keyed table, so a plain member check is
-- fine — the per-row-correlation concern from 20260616 doesn't apply.
create policy "household_ocr_config_read_member" on public.household_ocr_config
  for select using (
    public.is_household_member(household_id, (select auth.uid()))
    or public.is_admin((select auth.uid()))
  );

-- Owner-scoped UPDATE for defense-in-depth / admin parity; real writes go
-- through set_household_ocr_config (security definer). No INSERT/DELETE
-- policies — the RPC is the only write path; DELETE cascades from households.
create policy "household_ocr_config_owner_update" on public.household_ocr_config
  for update using (
    household_id in (
      select id from public.households where owner_id = (select auth.uid())
    )
    or public.is_admin((select auth.uid()))
  );

-- ---------- set_household_ocr_config (owner-only write) ----------
create or replace function public.set_household_ocr_config(
  p_household_id uuid,
  p_enabled boolean,
  p_provider text,
  p_model text,
  p_prompt text default null,
  p_fallback_provider text default null,
  p_fallback_model text default null,
  p_key_owner_id uuid default null      -- null => default to caller (owner)
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_key_owner uuid;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- OWNER-only (same shape as rename_household / delete_household).
  if not exists (
    select 1 from public.households
    where id = p_household_id and owner_id = v_user
  ) then
    raise exception 'Only the household owner can configure shared OCR.'
      using errcode = '42501';
  end if;

  if p_provider not in ('gemini', 'openai-compatible') then
    raise exception 'Unknown OCR provider %', p_provider using errcode = '22023';
  end if;
  if p_fallback_provider is not null
     and p_fallback_provider not in ('gemini', 'openai-compatible') then
    raise exception 'Unknown fallback provider %', p_fallback_provider using errcode = '22023';
  end if;

  v_key_owner := coalesce(p_key_owner_id, v_user);

  -- key_owner must be an ACTIVE member of THIS household.
  if not exists (
    select 1 from public.household_members
    where household_id = p_household_id
      and user_id = v_key_owner
      and left_at is null
  ) then
    raise exception 'The key owner must be an active member of the household.'
      using errcode = 'P0001';
  end if;

  -- Enabling with no resolvable key is a foot-gun: fail loudly.
  if p_enabled and not exists (
    select 1 from public.user_ocr_keys
    where owner_id = v_key_owner and provider = p_provider
  ) then
    raise exception 'The chosen key owner has no % key configured.', p_provider
      using errcode = 'P0001';
  end if;

  insert into public.household_ocr_config (
    household_id, ocr_share_enabled, provider, model, prompt,
    fallback_provider, fallback_model, key_owner_id
  ) values (
    p_household_id, p_enabled, p_provider, coalesce(p_model, ''),
    nullif(btrim(coalesce(p_prompt, '')), ''),
    p_fallback_provider, p_fallback_model, v_key_owner
  )
  on conflict (household_id) do update set
    ocr_share_enabled = excluded.ocr_share_enabled,
    provider          = excluded.provider,
    model             = excluded.model,
    prompt            = excluded.prompt,
    fallback_provider = excluded.fallback_provider,
    fallback_model    = excluded.fallback_model,
    key_owner_id      = excluded.key_owner_id;

  perform public.record_audit(
    case when p_enabled then 'HOUSEHOLD_OCR_ENABLED' else 'HOUSEHOLD_OCR_DISABLED' end,
    'HOUSEHOLD', p_household_id, p_household_id,
    -- Never log key material; only the non-secret pointers.
    jsonb_build_object(
      'provider', p_provider, 'model', p_model,
      'fallback_provider', p_fallback_provider, 'fallback_model', p_fallback_model,
      'key_owner_id', v_key_owner
    )
  );
end;
$$;

revoke all on function public.set_household_ocr_config(uuid, boolean, text, text, text, text, text, uuid)
  from public, anon;
grant execute on function public.set_household_ocr_config(uuid, boolean, text, text, text, text, text, uuid)
  to authenticated;

-- ---------- ocr_resolve_effective_key (service-role only) ----------
-- The worker's key lookup: own key first, else the household's borrowed key.
-- Mirrors ocr_resolve_key but adds the household fallback with strict
-- provider-containment so a member can't siphon the owner's key for a
-- provider the owner never agreed to share.
create or replace function public.ocr_resolve_effective_key(
  p_owner_id uuid,
  p_provider text
)
returns table(api_key text, base_url text, key_owner_id uuid)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_cfg public.household_ocr_config%rowtype;
begin
  if p_owner_id is null then
    raise exception 'p_owner_id is required' using errcode = '22023';
  end if;
  if p_provider not in ('gemini', 'openai-compatible') then
    raise exception 'Unknown OCR provider %', p_provider using errcode = '22023';
  end if;

  -- (a) Own key wins.
  return query
    select s.decrypted_secret::text, k.base_url, k.owner_id
      from public.user_ocr_keys k
      join vault.decrypted_secrets s on s.id = k.vault_secret_id
     where k.owner_id = p_owner_id and k.provider = p_provider;
  if found then
    return;
  end if;

  -- (b) Else borrow the household key — only if sharing is enabled and the
  --     requesting member is ACTIVE in that household.
  select cfg.* into v_cfg
    from public.household_ocr_config cfg
    join public.household_members m on m.household_id = cfg.household_id
   where cfg.ocr_share_enabled = true
     and m.user_id = p_owner_id
     and m.left_at is null
   limit 1;

  if v_cfg.household_id is null then
    return;  -- no own key, no shared config: caller treats as "no key"
  end if;

  -- Provider containment: the borrowed key is only for the household's
  -- configured shared provider (or its fallback provider, which the
  -- recitation path legitimately uses). Deny anything else.
  if p_provider <> v_cfg.provider
     and (v_cfg.fallback_provider is null or p_provider <> v_cfg.fallback_provider) then
    return;
  end if;

  -- The key owner must still be an active member.
  if not exists (
    select 1 from public.household_members
    where household_id = v_cfg.household_id
      and user_id = v_cfg.key_owner_id
      and left_at is null
  ) then
    return;
  end if;

  return query
    select s.decrypted_secret::text, k.base_url, k.owner_id
      from public.user_ocr_keys k
      join vault.decrypted_secrets s on s.id = k.vault_secret_id
     where k.owner_id = v_cfg.key_owner_id and k.provider = p_provider;
end;
$$;

revoke all on function public.ocr_resolve_effective_key(uuid, text) from public, authenticated, anon;
grant execute on function public.ocr_resolve_effective_key(uuid, text) to service_role;

-- ---------- cost attribution: which member's key paid ----------
-- Null => the batch owner used their own key. Set by the client at batch
-- creation when the effective config came from the household.
alter table public.import_batches
  add column key_owner_id uuid references public.profiles(id);
