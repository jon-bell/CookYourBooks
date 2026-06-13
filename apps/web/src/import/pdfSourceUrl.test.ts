import { describe, expect, it } from 'vitest';
import { findSourceUrlInItems } from './pdfSourceUrl.js';

// A page is 800 user-units tall; origin is bottom-left, so y≈800 is the
// header band and y≈0 is the footer band. Helper builds a pdfjs-shaped item.
const HEIGHT = 800;
const item = (str: string, y: number) => ({ str, transform: [1, 0, 0, 1, 50, y] });

describe('findSourceUrlInItems', () => {
  it('pulls the URL from the footer band (Safari print footer)', () => {
    const items = [
      item('Sheet-Pan Chicken', HEIGHT - 10), // header: title
      item('A delicious recipe', HEIGHT / 2), // body (ignored)
      item('https://cooking.nytimes.com/recipes/1234-sheet-pan-chicken', 20), // footer
      item('6/13/26, 2:47 PM', 20),
      item('Page 1 of 3', 20),
    ];
    expect(findSourceUrlInItems(items, HEIGHT)).toBe(
      'https://cooking.nytimes.com/recipes/1234-sheet-pan-chicken',
    );
  });

  it('falls back to the header band when the footer has no URL', () => {
    const items = [
      item('https://www.seriouseats.com/best-pancakes', HEIGHT - 5), // header
      item('Pancakes', HEIGHT / 2),
      item('Page 1 of 2', 15), // footer, no URL
    ];
    expect(findSourceUrlInItems(items, HEIGHT)).toBe('https://www.seriouseats.com/best-pancakes');
  });

  it('strips trailing punctuation appended after the URL', () => {
    const items = [item('Source: https://example.com/recipe.', 20)];
    expect(findSourceUrlInItems(items, HEIGHT)).toBe('https://example.com/recipe');
  });

  it('prepends https:// for a bare www. footer URL', () => {
    const items = [item('www.bbcgoodfood.com/recipes/x', 18)];
    expect(findSourceUrlInItems(items, HEIGHT)).toBe('https://www.bbcgoodfood.com/recipes/x');
  });

  it('ignores a URL that appears only in the page body', () => {
    const items = [
      item('Title', HEIGHT - 5),
      item('visit https://ads.example.com somewhere mid-page', HEIGHT / 2),
    ];
    expect(findSourceUrlInItems(items, HEIGHT)).toBeNull();
  });

  it('returns null when no URL is present and tolerates malformed items', () => {
    const items = [
      item('Just a title', HEIGHT - 5),
      // marked-content-style item with no str/transform
      { foo: 'bar' } as unknown as { str: string; transform: number[] },
      item('Page 1 of 1', 10),
    ];
    expect(findSourceUrlInItems(items, HEIGHT)).toBeNull();
  });
});
