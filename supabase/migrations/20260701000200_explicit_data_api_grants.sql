-- Explicit Data API grants for the public schema.
--
-- Supabase CLI v2.106.0 (2026-06-11) stopped auto-exposing new public
-- schema objects through the Data API: `[api].auto_expose_new_tables`
-- now defaults to false, and local start/reset revokes the default
-- grants for anon/authenticated/service_role on tables, sequences and
-- functions created by migrations (matching the default for
-- newly-created hosted projects). A fresh local stack therefore came
-- up with anon unable to SELECT anything and CI's PostgREST readiness
-- probe failed with 42501. The existing hosted project still has the
-- legacy auto-grant ACLs, so re-granting there is a no-op.
--
-- RLS remains the enforcement layer — every table has it enabled, and
-- these grants only restore the Data API surface the app has always
-- assumed. Functions are deliberately NOT blanket-granted: the house
-- style is an explicit revoke+grant pair per RPC (verified: every
-- client-called RPC has its own `grant execute ... to authenticated`),
-- and `GRANT ALL ON ALL FUNCTIONS` would re-expose the worker RPCs
-- that earlier migrations locked down to service_role.

grant usage on schema public to anon, authenticated, service_role;

grant select on all tables in schema public to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

grant usage, select on all sequences in schema public to anon, authenticated;
grant all on all sequences in schema public to service_role;

-- user_ocr_keys: 20260522000000 column-revoked vault_secret_id from
-- authenticated as defense in depth, but a column REVOKE is a no-op
-- while a table-level SELECT grant exists, so the legacy auto-grant
-- quietly defeated it. Replace the table-level grant with an explicit
-- column list so the vault pointer is now genuinely unreadable. The
-- app already projects exactly these columns (listOcrKeys in
-- apps/web/src/import/api.ts); writes go through the security-definer
-- ocr_key_set / ocr_key_delete RPCs.
revoke select on table public.user_ocr_keys from anon, authenticated;
grant select (owner_id, provider, key_fingerprint, base_url, created_at, rotated_at)
  on public.user_ocr_keys to authenticated;

-- Restore the legacy default ACLs for future objects: migrations run
-- as postgres, so tables/sequences created by later migrations pick up
-- the same grants without each migration repeating them. This mirrors
-- the default-privilege state still active on the existing hosted
-- project. (Functions excluded on purpose — new RPCs keep the explicit
-- revoke+grant convention.)
alter default privileges for role postgres in schema public
  grant select on tables to anon;
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges for role postgres in schema public
  grant all on tables to service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to anon, authenticated;
alter default privileges for role postgres in schema public
  grant all on sequences to service_role;
