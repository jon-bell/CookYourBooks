export type UnitSystem = 'METRIC' | 'IMPERIAL' | 'WHOLE' | 'SPECIAL';
export type UnitDimension = 'VOLUME' | 'WEIGHT' | 'COUNT' | 'TASTE';

export interface UnitDef {
  readonly name: string;
  readonly abbreviations: readonly string[];
  readonly system: UnitSystem;
  readonly dimension: UnitDimension;
}

// Canonical unit catalog. The `name` is the stable identifier stored in quantities.
export const Units = {
  // Volume — metric
  MILLILITER: {
    name: 'milliliter',
    abbreviations: ['ml', 'mL'],
    system: 'METRIC',
    dimension: 'VOLUME',
  },
  LITER: { name: 'liter', abbreviations: ['l', 'L'], system: 'METRIC', dimension: 'VOLUME' },
  // Volume — imperial / US
  TEASPOON: {
    name: 'teaspoon',
    abbreviations: ['tsp', 't'],
    system: 'IMPERIAL',
    dimension: 'VOLUME',
  },
  TABLESPOON: {
    name: 'tablespoon',
    abbreviations: ['tbsp', 'T', 'tbs'],
    system: 'IMPERIAL',
    dimension: 'VOLUME',
  },
  CUP: { name: 'cup', abbreviations: ['c'], system: 'IMPERIAL', dimension: 'VOLUME' },
  FLUID_OUNCE: {
    name: 'fluid ounce',
    abbreviations: ['fl oz', 'floz'],
    system: 'IMPERIAL',
    dimension: 'VOLUME',
  },
  PINT: { name: 'pint', abbreviations: ['pt'], system: 'IMPERIAL', dimension: 'VOLUME' },
  QUART: { name: 'quart', abbreviations: ['qt'], system: 'IMPERIAL', dimension: 'VOLUME' },
  GALLON: { name: 'gallon', abbreviations: ['gal'], system: 'IMPERIAL', dimension: 'VOLUME' },
  // Weight — metric
  GRAM: { name: 'gram', abbreviations: ['g'], system: 'METRIC', dimension: 'WEIGHT' },
  KILOGRAM: { name: 'kilogram', abbreviations: ['kg'], system: 'METRIC', dimension: 'WEIGHT' },
  // Weight — imperial
  OUNCE: { name: 'ounce', abbreviations: ['oz'], system: 'IMPERIAL', dimension: 'WEIGHT' },
  POUND: { name: 'pound', abbreviations: ['lb', 'lbs'], system: 'IMPERIAL', dimension: 'WEIGHT' },
  // Count
  PIECE: { name: 'piece', abbreviations: ['pc', 'pcs'], system: 'WHOLE', dimension: 'COUNT' },
  CLOVE: { name: 'clove', abbreviations: [], system: 'WHOLE', dimension: 'COUNT' },
  BUNCH: { name: 'bunch', abbreviations: [], system: 'WHOLE', dimension: 'COUNT' },
  /** Serving count unit — "serves 4 people". Dimensionless / yield-only. */
  PEOPLE: { name: 'people', abbreviations: [], system: 'WHOLE', dimension: 'COUNT' },
  // Taste (dimensionless)
  PINCH: { name: 'pinch', abbreviations: [], system: 'SPECIAL', dimension: 'TASTE' },
  DASH: { name: 'dash', abbreviations: [], system: 'SPECIAL', dimension: 'TASTE' },
  HANDFUL: { name: 'handful', abbreviations: [], system: 'SPECIAL', dimension: 'TASTE' },
  TO_TASTE: { name: 'to taste', abbreviations: [], system: 'SPECIAL', dimension: 'TASTE' },
} as const satisfies Record<string, UnitDef>;

export type UnitKey = keyof typeof Units;

const byName = new Map<string, UnitDef>();
const byAbbr = new Map<string, UnitDef>();
for (const u of Object.values(Units)) {
  byName.set(u.name.toLowerCase(), u);
  for (const abbr of u.abbreviations) byAbbr.set(abbr.toLowerCase(), u);
}

export function findUnit(token: string): UnitDef | undefined {
  const t = token.trim().toLowerCase();
  return byName.get(t) ?? byAbbr.get(t);
}

export function unitByName(name: string): UnitDef | undefined {
  return byName.get(name.toLowerCase());
}

// The canonicalizer accepts three kinds of input the wild produces:
//   (a) a catalog key like `CUP` / `PEOPLE` / `GRAM` (upper-case, the
//       form the LLM prompt asks the model to use);
//   (b) a canonical name like `cup` / `people` / `gram`;
//   (c) a known abbreviation like `tsp` / `kg`.
// Returns the canonical lowercase name — what we actually store on
// quantities so display is consistent regardless of source. Unknown
// tokens round-trip unchanged (we don't want to destroy data the UI
// can still render literally).
const byKey = new Map<string, UnitDef>(
  Object.entries(Units).map(([k, v]) => [k.toLowerCase(), v]),
);
// "WHOLE" is sometimes emitted by LLMs for countable yields (eggs,
// loaves). We map it to `piece`, the closest thing in the catalog.
byKey.set('whole', Units.PIECE);

export function canonicalUnitName(token: string | null | undefined): string {
  if (!token) return '';
  const t = token.trim();
  if (!t) return '';
  const lower = t.toLowerCase();
  return (
    byKey.get(lower)?.name ??
    byName.get(lower)?.name ??
    byAbbr.get(lower)?.name ??
    t
  );
}
