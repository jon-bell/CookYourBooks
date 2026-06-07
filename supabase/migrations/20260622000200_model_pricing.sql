-- Local cache of current LLM per-token pricing for OCR cost computation.
--
-- The worker refreshes this from models.dev (primary) + OpenRouter (fallback)
-- and reads it to turn token usage into cost. Persisting in a table (vs an
-- in-memory worker cache) survives the worker's constant cold starts and is
-- shared across the concurrent worker slots. The bundled pricing.json stays
-- in the worker as the offline fallback + seed; a model missing from BOTH the
-- table and the snapshot is logged loudly (never silently billed at $0).
--
-- Service-role only: the worker (service role) reads + upserts directly,
-- bypassing RLS. Clients have no business reading pricing, so no policies.
create table public.model_pricing (
  provider text not null,                 -- 'gemini' | 'openai-compatible'
  model text not null,                    -- our app model string
  input_usd_per_mtok numeric not null,
  output_usd_per_mtok numeric not null,
  source text not null,                   -- 'models.dev' | 'openrouter' | 'bundled'
  fetched_at timestamptz not null default now(),
  primary key (provider, model)
);

alter table public.model_pricing enable row level security;
-- No policies: only service_role (which bypasses RLS) touches this table.
