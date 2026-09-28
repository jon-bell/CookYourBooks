// Which OCR draft is the recipe a corpus folder was uploaded for? A recipe's
// pages usually also carry neighbouring recipes (often cut off at the page
// edge); `demo load` keeps only the named one. The folder slug is derived from
// the recipe's title in scripts/demo-content/sources.ts, so every slug word
// should appear in the OCR'd title — which may add a translation, e.g. slug
// "minestrone-alla-milanese" vs "Vegetable Chowder (Minestrone alla Milanese)".

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Share of the slug's words present in the title, 0..1. */
export function slugTitleScore(slug: string, title: string): number {
  const want = words(slug);
  if (want.length === 0) return 0;
  const have = new Set(words(title));
  return want.filter((w) => have.has(w)).length / want.length;
}

/** Index of the draft whose title best matches the slug, or -1 when none
 *  covers at least `minScore` of the slug's words. */
export function pickTargetDraft(
  drafts: readonly { title?: string }[],
  slug: string,
  minScore = 0.6,
): number {
  let best = -1;
  let bestScore = -1;
  drafts.forEach((d, i) => {
    const score = slugTitleScore(slug, d.title ?? '');
    if (score >= minScore && score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}
