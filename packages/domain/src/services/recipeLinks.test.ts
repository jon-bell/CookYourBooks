import { describe, expect, it } from 'vitest';

import {
  buildTitleIndex,
  type CollectionTitleEntry,
  normalizeForLink,
  resolveIngredientLink,
} from './recipeLinks.js';

// The cases below are real ingredient / title pairs pulled from the
// production recipe corpus (jon's library), plus the guard cases. The
// caller always passes an index built from the HOST recipe's own
// collection, so every case here is implicitly "same book" — cross-book
// exclusion is structural, not the matcher's job.

const HOST = 'host-recipe';

// Build an index from [title, hasContent?] tuples. recipeId defaults to the
// slugified title so assertions can name the expected target by title.
function idx(...entries: Array<[string, boolean?]>): {
  index: ReturnType<typeof buildTitleIndex>;
  id: (title: string) => string;
} {
  const rid = (t: string): string => `rid:${normalizeForLink(t)}`;
  const rows: CollectionTitleEntry[] = entries.map(([title, hasContent = true]) => ({
    recipeId: rid(title),
    title,
    hasContent,
  }));
  return { index: buildTitleIndex(rows), id: rid };
}

describe('resolveIngredientLink', () => {
  it('links an exact same-collection title (case-insensitive)', () => {
    const { index, id } = idx(['Double almond crust'], ['Amaretto pastry cream']);
    expect(resolveIngredientLink('Double Almond Crust', HOST, 'Almond Cream Pie', index)).toEqual({
      recipeId: id('Double almond crust'),
      isPlaceholder: false,
    });
  });

  it('links single-word staples within the book (aggressive)', () => {
    // Cross-book "salt"→"Salt" is prevented by the caller's per-collection
    // index; within one book a recipe literally titled "Chicken broth" is a
    // legitimate component target.
    const { index, id } = idx(['Chicken broth']);
    expect(resolveIngredientLink('chicken broth', HOST, 'Bean Soup', index)?.recipeId).toBe(
      id('Chicken broth'),
    );
  });

  it('normalizes punctuation and casing (hyphens, ALLCAPS)', () => {
    const { index, id } = idx(['Ginger-garlic paste'], ['PEPPERCORN SAUCE']);
    expect(
      resolveIngredientLink('Ginger-Garlic Paste (for sauce)', HOST, 'Orange Duck', index)
        ?.recipeId,
    ).toBe(id('Ginger-garlic paste'));
    expect(resolveIngredientLink('Peppercorn sauce', HOST, 'Beef Rib', index)?.recipeId).toBe(
      id('PEPPERCORN SAUCE'),
    );
  });

  it('strips trailing page-refs and parenthetical qualifiers', () => {
    const { index, id } = idx(['Sous vide fish stock'], ['Pickled red onion']);
    expect(
      resolveIngredientLink('Sous Vide Fish Stock (see page 87)', HOST, 'Bell Pepper Soup', index)
        ?.recipeId,
    ).toBe(id('Sous vide fish stock'));
    expect(
      resolveIngredientLink('Pickled Red Onion (page 293)', HOST, 'Winter Squash', index)?.recipeId,
    ).toBe(id('Pickled red onion'));
  });

  it('strips a trailing comma prep clause for the exact match', () => {
    const { index, id } = idx(['Sous vide chicken']);
    expect(
      resolveIngredientLink(
        'Sous Vide Chicken, warm and sliced',
        HOST,
        'Chicken Noodle Soup',
        index,
      )?.recipeId,
    ).toBe(id('Sous vide chicken'));
  });

  it('matches a multi-word title contained in the ingredient name', () => {
    const { index, id } = idx(
      ['Pomegranate molasses'],
      ['Citric acid solution'],
      ['Vanilla ice cream'],
      ['White sandwich bread'],
    );
    expect(
      resolveIngredientLink('unsweetened pomegranate molasses', HOST, 'Red Cabbage', index)
        ?.recipeId,
    ).toBe(id('Pomegranate molasses'));
    expect(
      resolveIngredientLink('15% citric acid solution', HOST, 'Milk-Washed Oolong', index)
        ?.recipeId,
    ).toBe(id('Citric acid solution'));
    expect(
      resolveIngredientLink('vanilla ice cream or frozen yogurt', HOST, 'Peach Compote', index)
        ?.recipeId,
    ).toBe(id('Vanilla ice cream'));
    expect(
      resolveIngredientLink(
        'hearty white sandwich bread, torn into 1/2-inch pieces',
        HOST,
        'Meatball Soup',
        index,
      )?.recipeId,
    ).toBe(id('White sandwich bread'));
  });

  it('prefers the exact match over a contained one ("... or Basic ...")', () => {
    const { index, id } = idx(['Advanced babka dough'], ['Basic babka dough']);
    // Both titles are substrings; exact on the leading phrase wins.
    expect(
      resolveIngredientLink(
        'Advanced Babka Dough (or Basic Babka Dough)',
        HOST,
        'Chocolate Babka',
        index,
      )?.recipeId,
    ).toBe(id('Advanced babka dough'));
  });

  it('links to a placeholder target and flags it', () => {
    const { index, id } = idx(['Blitz puff pastry dough', false]);
    expect(resolveIngredientLink('Blitz Puff Pastry Dough', HOST, 'Beef Pot Pie', index)).toEqual({
      recipeId: id('Blitz puff pastry dough'),
      isPlaceholder: true,
    });
  });

  it('prefers a real recipe over a same-titled placeholder', () => {
    const rows: CollectionTitleEntry[] = [
      { recipeId: 'placeholder', title: 'Chicken stock', hasContent: false },
      { recipeId: 'real', title: 'Chicken stock', hasContent: true },
    ];
    expect(
      resolveIngredientLink('chicken stock', HOST, 'Artichoke Soup', buildTitleIndex(rows)),
    ).toEqual({ recipeId: 'real', isPlaceholder: false });
  });

  it('does not link the host recipe to itself', () => {
    const { index } = idx(['Mayonnaise']);
    // ingredient equals the host's own title
    expect(resolveIngredientLink('Mayonnaise', HOST, 'Mayonnaise', index)).toBeNull();
    // ingredient points at the host recipe id
    const rows: CollectionTitleEntry[] = [
      { recipeId: HOST, title: 'Mayonnaise', hasContent: true },
    ];
    expect(
      resolveIngredientLink('mayonnaise', HOST, 'A Better Burger', buildTitleIndex(rows)),
    ).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const { index } = idx(['Chicken broth'], ['Pizza dough']);
    expect(resolveIngredientLink('kosher salt', HOST, 'Roast Chicken', index)).toBeNull();
  });

  it('does not contain-match a single-word title', () => {
    // "Salt" (1 word) must not match "kosher salt" by containment.
    const { index } = idx(['Salt']);
    expect(resolveIngredientLink('kosher salt', HOST, 'Brine', index)).toBeNull();
  });

  it('ignores degenerate names (too short / numeric)', () => {
    const { index } = idx(['Ice']);
    expect(resolveIngredientLink('ic', HOST, 'Drink', index)).toBeNull();
    expect(resolveIngredientLink('2', HOST, 'Drink', index)).toBeNull();
  });

  it('skips genuinely ambiguous ties (two different real recipes, same title)', () => {
    const rows: CollectionTitleEntry[] = [
      { recipeId: 'a', title: 'Simple syrup', hasContent: true },
      { recipeId: 'b', title: 'Simple syrup', hasContent: true },
    ];
    expect(
      resolveIngredientLink('simple syrup', HOST, 'Cocktail', buildTitleIndex(rows)),
    ).toBeNull();
  });
});
