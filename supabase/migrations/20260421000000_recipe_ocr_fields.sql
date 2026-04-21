-- Richer recipe metadata — driven by the vision-model OCR path.
--
-- Everything added here is nullable / optional. The minimum-viable
-- recipe (title + ingredients + steps) keeps working as before; the
-- new columns only get populated when the source has data to fill
-- them (most often the LLM-based OCR importer).
--
-- Array-ish columns are stored as `jsonb` rather than native Postgres
-- arrays so the local-first SQLite mirror can persist them as JSON
-- text without a round-trip through arraystring parsing on every
-- sync. The mapping helpers (`packages/db/src/mapping.ts`) normalize
-- either representation back to plain JS arrays on read.

-- ---------- recipes ----------

alter table public.recipes
  add column if not exists description text,
  add column if not exists time_estimate text,
  add column if not exists equipment jsonb,           -- string[]
  add column if not exists book_title text,
  add column if not exists page_numbers jsonb,        -- number[]
  add column if not exists source_image_text text,
  add column if not exists servings_amount_max numeric;

-- ---------- ingredients ----------

-- The "to taste" / "as needed" qualifier that the OCR prompt surfaces
-- for vague ingredients. Kept distinct from `preparation` (how the
-- ingredient is prepared) and `notes` (free-form extras).
alter table public.ingredients
  add column if not exists description text;

-- ---------- instructions ----------

alter table public.instructions
  add column if not exists temperature_value numeric,
  add column if not exists temperature_unit text
    check (temperature_unit in ('FAHRENHEIT', 'CELSIUS')),
  add column if not exists sub_instructions jsonb,    -- string[]
  add column if not exists notes text;

-- ---------- instruction_ingredient_refs ----------

-- Per-step "how much of this ingredient is consumed *here*". When
-- NULL, Cook Mode falls back to the ingredient's full quantity.
alter table public.instruction_ingredient_refs
  add column if not exists consumed_quantity_type text
    check (consumed_quantity_type in ('EXACT', 'FRACTIONAL', 'RANGE')),
  add column if not exists consumed_quantity_amount numeric,
  add column if not exists consumed_quantity_whole integer,
  add column if not exists consumed_quantity_numerator integer,
  add column if not exists consumed_quantity_denominator integer,
  add column if not exists consumed_quantity_min numeric,
  add column if not exists consumed_quantity_max numeric,
  add column if not exists consumed_quantity_unit text;
