-- Curated density defaults sourced from King Arthur Baking's
-- Ingredient Weight Chart (https://www.kingarthurbaking.com/learn/
-- ingredient-weight-chart) plus widely-cited US baking references.
-- Numbers are normalized to milliliter→gram using the US standard
-- 1 cup = 240 mL convention that the existing seed already uses.
--
-- All inserts are `on conflict do nothing` so admin tweaks to existing
-- rows survive a re-run. This file is additive — never edit a previous
-- row's factor here; do it through the admin UI / global_conversion
-- RPC so the change is attributed.
--
-- Notes column records the source per-cup figure so anyone reviewing
-- a row can verify the math (factor × 240 ≈ g/cup).
--
-- Coverage decisions:
--   - Generic names ("flour", "sugar", "butter") already exist from the
--     2026-06-02 seed. We don't shadow those — only ADD specific
--     variants and uncovered ingredients.
--   - Lookup in `useRecipeNutrition` is exact-match (case-insensitive)
--     on ingredient name, so "all-purpose flour" matches recipe text
--     "All-Purpose Flour" but NOT "flour" (which falls through to the
--     generic). Be precise in `ingredient_name` here.

-- ---------- Flours ----------
insert into public.global_conversions (from_unit, to_unit, factor, ingredient_name, notes) values
  ('milliliter', 'gram', 0.50, 'all-purpose flour',     '120 g/cup, scoop and level (KA)'),
  ('milliliter', 'gram', 0.50, 'bread flour',            '120 g/cup (KA)'),
  ('milliliter', 'gram', 0.47, 'cake flour',             '113 g/cup (KA)'),
  ('milliliter', 'gram', 0.47, 'pastry flour',           '113 g/cup (KA)'),
  ('milliliter', 'gram', 0.47, 'whole wheat flour',      '113 g/cup (KA)'),
  ('milliliter', 'gram', 0.50, 'whole wheat pastry flour','120 g/cup (KA)'),
  ('milliliter', 'gram', 0.40, 'almond flour',           '96 g/cup (KA)'),
  ('milliliter', 'gram', 0.40, 'coconut flour',          '96 g/cup'),
  ('milliliter', 'gram', 0.50, 'rye flour',              '120 g/cup'),
  ('milliliter', 'gram', 0.50, 'semolina',               '120 g/cup'),
  ('milliliter', 'gram', 0.50, 'cornmeal',               '120 g/cup'),
  ('milliliter', 'gram', 0.50, 'cornstarch',             '120 g/cup')
on conflict (from_unit, to_unit, ingredient_name) do nothing;

-- ---------- Sugars and sweeteners ----------
insert into public.global_conversions (from_unit, to_unit, factor, ingredient_name, notes) values
  ('milliliter', 'gram', 0.83, 'granulated sugar',       '198 g/cup (KA)'),
  ('milliliter', 'gram', 0.83, 'white sugar',            '198 g/cup'),
  ('milliliter', 'gram', 0.89, 'brown sugar',            '213 g/cup, packed (KA)'),
  ('milliliter', 'gram', 0.89, 'light brown sugar',      '213 g/cup, packed'),
  ('milliliter', 'gram', 0.89, 'dark brown sugar',       '213 g/cup, packed'),
  ('milliliter', 'gram', 0.47, 'confectioners sugar',    '113 g/cup, unsifted (KA)'),
  ('milliliter', 'gram', 0.47, 'powdered sugar',         '113 g/cup'),
  ('milliliter', 'gram', 1.42, 'molasses',               '340 g/cup'),
  ('milliliter', 'gram', 1.30, 'maple syrup',            '312 g/cup'),
  ('milliliter', 'gram', 1.42, 'corn syrup',             '340 g/cup'),
  ('milliliter', 'gram', 0.83, 'agave nectar',           '~200 g/cup')
on conflict (from_unit, to_unit, ingredient_name) do nothing;

-- ---------- Fats and oils ----------
insert into public.global_conversions (from_unit, to_unit, factor, ingredient_name, notes) values
  ('milliliter', 'gram', 0.95, 'unsalted butter',        '227 g/cup; 1 stick = 113 g'),
  ('milliliter', 'gram', 0.95, 'salted butter',          '227 g/cup; 1 stick = 113 g'),
  ('milliliter', 'gram', 0.82, 'olive oil',              '198 g/cup (KA)'),
  ('milliliter', 'gram', 0.82, 'vegetable oil',          '198 g/cup'),
  ('milliliter', 'gram', 0.82, 'canola oil',             '198 g/cup'),
  ('milliliter', 'gram', 0.83, 'coconut oil',            '~200 g/cup, melted'),
  ('milliliter', 'gram', 0.85, 'shortening',             '205 g/cup'),
  ('milliliter', 'gram', 1.04, 'peanut butter',          '250 g/cup (KA)'),
  ('milliliter', 'gram', 1.04, 'almond butter',          '~250 g/cup')
on conflict (from_unit, to_unit, ingredient_name) do nothing;

-- ---------- Dairy and dairy-like ----------
insert into public.global_conversions (from_unit, to_unit, factor, ingredient_name, notes) values
  ('milliliter', 'gram', 0.95, 'buttermilk',             '227 g/cup'),
  ('milliliter', 'gram', 0.97, 'heavy cream',            '232 g/cup'),
  ('milliliter', 'gram', 1.01, 'half-and-half',          '242 g/cup'),
  ('milliliter', 'gram', 0.95, 'sour cream',             '227 g/cup'),
  ('milliliter', 'gram', 0.95, 'greek yogurt',           '227 g/cup'),
  ('milliliter', 'gram', 1.03, 'yogurt',                 '247 g/cup'),
  ('milliliter', 'gram', 1.02, 'condensed milk',         '~245 g/cup, sweetened'),
  ('milliliter', 'gram', 1.04, 'evaporated milk',        '~250 g/cup')
on conflict (from_unit, to_unit, ingredient_name) do nothing;

-- ---------- Salts (the big one — kosher salts vary 2× by brand) ----------
insert into public.global_conversions (from_unit, to_unit, factor, ingredient_name, notes) values
  ('milliliter', 'gram', 1.22, 'table salt',             '6.0 g/tsp (4.93 mL/tsp)'),
  ('milliliter', 'gram', 1.22, 'fine sea salt',          '6.0 g/tsp'),
  ('milliliter', 'gram', 0.97, 'morton kosher salt',     '4.8 g/tsp — heavier flake'),
  ('milliliter', 'gram', 0.57, 'diamond crystal kosher salt', '2.8 g/tsp — light flake'),
  ('milliliter', 'gram', 1.22, 'kosher salt',            '6.0 g/tsp — assumes table; specify brand for precision')
on conflict (from_unit, to_unit, ingredient_name) do nothing;

-- ---------- Leaveners and small-quantity dry ----------
insert into public.global_conversions (from_unit, to_unit, factor, ingredient_name, notes) values
  ('milliliter', 'gram', 0.93, 'baking soda',            '4.6 g/tsp'),
  ('milliliter', 'gram', 0.81, 'baking powder',          '4.0 g/tsp'),
  ('milliliter', 'gram', 1.01, 'active dry yeast',       '~5 g/tsp'),
  ('milliliter', 'gram', 1.01, 'instant yeast',          '~5 g/tsp'),
  ('milliliter', 'gram', 0.35, 'cocoa powder',           '85 g/cup, sifted (KA)'),
  ('milliliter', 'gram', 0.71, 'chocolate chips',        '170 g/cup'),
  ('milliliter', 'gram', 1.20, 'vanilla extract',        '~4 g/tsp; mostly water + alcohol')
on conflict (from_unit, to_unit, ingredient_name) do nothing;

-- ---------- Grains and nuts ----------
insert into public.global_conversions (from_unit, to_unit, factor, ingredient_name, notes) values
  ('milliliter', 'gram', 0.41, 'rolled oats',            '99 g/cup (KA)'),
  ('milliliter', 'gram', 0.50, 'steel-cut oats',         '120 g/cup'),
  ('milliliter', 'gram', 0.77, 'long-grain rice',        '185 g/cup, uncooked'),
  ('milliliter', 'gram', 0.83, 'short-grain rice',       '200 g/cup, uncooked'),
  ('milliliter', 'gram', 0.83, 'arborio rice',           '200 g/cup, uncooked'),
  ('milliliter', 'gram', 0.42, 'panko breadcrumbs',      '100 g/cup'),
  ('milliliter', 'gram', 0.46, 'breadcrumbs',            '110 g/cup, dry'),
  ('milliliter', 'gram', 0.42, 'pecans',                 '100 g/cup, halves'),
  ('milliliter', 'gram', 0.50, 'walnuts',                '120 g/cup, halves'),
  ('milliliter', 'gram', 0.60, 'almonds',                '143 g/cup, whole'),
  ('milliliter', 'gram', 0.59, 'raisins',                '142 g/cup, packed'),
  ('milliliter', 'gram', 0.35, 'shredded coconut',       '85 g/cup, sweetened (KA)')
on conflict (from_unit, to_unit, ingredient_name) do nothing;

-- ---------- Whole-piece defaults ----------
-- The 2026-06-02 seed has egg + onion + garlic clove. Add a handful more.
insert into public.global_conversions (from_unit, to_unit, factor, ingredient_name, notes) values
  ('piece', 'gram', 80,   'shallot',         'medium'),
  ('piece', 'gram', 14,   'scallion',        'one whole, trimmed'),
  ('piece', 'gram', 120,  'tomato',          'medium plum-to-slicer range'),
  ('piece', 'gram', 200,  'bell pepper',     'medium'),
  ('piece', 'gram', 150,  'carrot',          'medium'),
  ('piece', 'gram', 60,   'celery stalk',    'one stalk, trimmed'),
  ('piece', 'gram', 200,  'potato',          'medium'),
  ('piece', 'gram', 130,  'lemon',           'medium; ~45 g juice, ~6 g zest'),
  ('piece', 'gram', 130,  'lime',            'medium; ~30 g juice'),
  ('piece', 'gram', 180,  'apple',           'medium'),
  ('piece', 'gram', 120,  'banana',          'medium peeled')
on conflict (from_unit, to_unit, ingredient_name) do nothing;
