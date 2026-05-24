-- Test-only table backing OCR_MOCK_MODE=1 in the import-worker Edge
-- Function. E2E tests insert one row per item-storage-path describing
-- what the (mocked) LLM should "return" — either a fake response body
-- or a forced error_kind. The worker reads these rows instead of
-- calling Gemini / OpenAI.
--
-- This is wired up only when OCR_MOCK_MODE=1 is set in the function's
-- environment. In production the env var is unset and this table is
-- never read.
--
-- NOT production data. Authenticated users can read so that test
-- harnesses signed in as a regular user can sanity-check fixtures
-- they've seeded via the service role, but no one except the service
-- role can insert / update / delete.

-- Composite PK on (item_storage_path, provider) so tests can seed
-- different responses per provider for the same item. The Wave 3.5
-- RECITATION-fallback test relies on this: the gemini row returns
-- RECITATION, the openai-compatible row returns OK, and the worker
-- naturally selects the right fixture per attempt by looking up its
-- own provider.
create table public.ocr_test_fixtures (
  item_storage_path text not null,
  provider text not null default ''
    check (provider in ('', 'gemini', 'openai-compatible')),
  response_json jsonb not null default '{}'::jsonb,
  error_kind text
    check (error_kind in (
      'OK', 'RECITATION', 'RATE_LIMIT', 'AUTH',
      'NETWORK', 'PARSE', 'TIMEOUT', 'OTHER'
    )),
  latency_ms int not null default 0,
  created_at timestamptz not null default now(),
  primary key (item_storage_path, provider)
);

alter table public.ocr_test_fixtures enable row level security;

create policy "ocr_test_fixtures_authenticated_read" on public.ocr_test_fixtures
  for select to authenticated using (true);
