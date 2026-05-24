-- Service-role-only resolver for the bulk OCR worker.
--
-- The Edge Function needs the plaintext API key for a (owner, provider)
-- pair. It cannot read `vault.decrypted_secrets` directly through
-- PostgREST because only the `public` and `graphql_public` schemas are
-- exposed, so we wrap the lookup in a security-definer RPC that the
-- worker can call from the public schema.

create or replace function public.ocr_resolve_key(
  p_owner_id uuid,
  p_provider text
)
returns table(api_key text, base_url text)
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if p_owner_id is null then
    raise exception 'p_owner_id is required' using errcode = '22023';
  end if;
  if p_provider not in ('gemini', 'openai-compatible') then
    raise exception 'Unknown OCR provider %', p_provider using errcode = '22023';
  end if;

  return query
  select s.decrypted_secret::text as api_key,
         k.base_url
    from public.user_ocr_keys k
    join vault.decrypted_secrets s on s.id = k.vault_secret_id
   where k.owner_id = p_owner_id
     and k.provider = p_provider;
end;
$$;

revoke all on function public.ocr_resolve_key(uuid, text) from public, authenticated, anon;
grant execute on function public.ocr_resolve_key(uuid, text) to service_role;
