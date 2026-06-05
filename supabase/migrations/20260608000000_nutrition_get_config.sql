-- The nutrition Edge Function reads its USDA key from the
-- `nutrition_worker_config` vault secret. PostgREST does NOT expose
-- the `vault` schema by default, so a direct
-- `from('vault.decrypted_secrets')` call from the Edge Function
-- silently returns no rows — USDA lookups then no-op and the function
-- falls through to OFF, which is currently rate-limited. This RPC
-- mirrors the SECURITY DEFINER pattern in `nutrition_health()` and
-- the import-worker's `ocr_resolve_key()`, returning the config JSON
-- to authorized callers only.

create or replace function public.nutrition_get_config()
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  cfg jsonb;
begin
  select decrypted_secret::jsonb into cfg
    from vault.decrypted_secrets
    where name = 'nutrition_worker_config'
    limit 1;
  return cfg;
end;
$$;

-- Service role only — this returns a secret to the caller. The Edge
-- Function authenticates with the service-role JWT before calling.
revoke all on function public.nutrition_get_config() from public, anon, authenticated;
grant execute on function public.nutrition_get_config() to service_role;
