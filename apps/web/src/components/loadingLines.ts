// Cooking-flavored homage to the classic SimCity loading screen ("Reticulating
// splines…"). Shared by the blocking overlays (schema upgrade, first sync) and
// the inline LoadingState, so every wait in the app reads as "we know this is
// slow and it's working", not "frozen".
export const COOKING_FLAVOR_LINES = [
  'Reticulating roux…',
  'Proofing the dough…',
  'Caramelizing onions (slowly, as one must)…',
  'Deglazing the database…',
  'Whisking the watermarks…',
  'Mincing shallots…',
  'Folding in the cheese…',
  'Blanching the foreign keys…',
  'Resting the brisket…',
  'Decanting the indexes…',
  'Tempering the chocolate…',
  'Seasoning to taste…',
  'Aligning the mise en place…',
  'Reducing the stock (by half)…',
  'Calibrating the oven mitts…',
  'Emulsifying the vinaigrette…',
  'Sharpening the knives…',
  'Consulting grandma’s notes…',
  'Preheating to 425°F…',
  'Skimming the stock…',
  'Toasting the spices…',
  'Zesting a lemon…',
  'Butterflying the bytes…',
  'Letting the flavors mingle…',
] as const;

/**
 * Interleave informational lines 1:1 with flavor lines so every other
 * rotation tells the user something real about what's happening. With no
 * informational lines it's pure flavor; with no flavor it's pure info.
 */
export function interleaveLines(
  info: readonly string[],
  flavor: readonly string[] = COOKING_FLAVOR_LINES,
): string[] {
  if (info.length === 0) return [...flavor];
  if (flavor.length === 0) return [...info];
  const out: string[] = [];
  const n = Math.max(info.length, flavor.length);
  for (let i = 0; i < n; i += 1) {
    out.push(info[i % info.length]!, flavor[i % flavor.length]!);
  }
  return out;
}
