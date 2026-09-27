import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCorpus } from './corpus.js';

let dir: string;

function page(book: string, recipe: string, file: string) {
  mkdirSync(join(dir, book, 'pages', recipe), { recursive: true });
  writeFileSync(join(dir, book, 'pages', recipe, file), 'jpeg');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cyb-corpus-'));
  mkdirSync(join(dir, 'italian'));
  writeFileSync(
    join(dir, 'italian', 'source.json'),
    JSON.stringify({ title: 'The Italian Cook Book', author: 'Maria Gentile', year: 1919 }),
  );
  page('italian', 'risotto', '01-leaf26.jpg');
  page('italian', 'gnocchi', '02-leaf12.jpg');
  page('italian', 'gnocchi', '01-leaf11.jpg');
  // Non-recipe sections and stray files are ignored.
  mkdirSync(join(dir, 'italian', 'index', 'index'), { recursive: true });
  writeFileSync(join(dir, 'italian', 'index', 'index', '01-leaf161.jpg'), 'jpeg');
  writeFileSync(join(dir, 'italian', 'pages', 'risotto', 'notes.txt'), 'x');

  mkdirSync(join(dir, 'receipts'));
  writeFileSync(
    join(dir, 'receipts', 'source.json'),
    JSON.stringify({ title: 'Manuscript Receipt Book', collection: 'personal' }),
  );
  // A folder without source.json isn't a book.
  mkdirSync(join(dir, 'scratch'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readCorpus', () => {
  it('reads books, recipes, and pages in reading order', () => {
    const books = readCorpus(dir);
    expect(books.map((b) => b.id)).toEqual(['italian', 'receipts']);
    const italian = books[0]!;
    expect(italian).toMatchObject({
      title: 'The Italian Cook Book',
      author: 'Maria Gentile',
      year: 1919,
      collection: 'cookbook',
    });
    expect(italian.recipes.map((r) => r.slug)).toEqual(['gnocchi', 'risotto']);
    expect(italian.recipes[0]!.pages.map((p) => p.slice(p.lastIndexOf('/') + 1))).toEqual([
      '01-leaf11.jpg',
      '02-leaf12.jpg',
    ]);
    expect(italian.recipes[1]!.pages).toHaveLength(1);
    expect(books[1]).toMatchObject({ collection: 'personal', author: null, recipes: [] });
  });

  it('filters by id and reports unknown ids', () => {
    expect(readCorpus(dir, ['receipts']).map((b) => b.id)).toEqual(['receipts']);
    expect(() => readCorpus(dir, ['nope'])).toThrow(/nope/);
  });

  it('explains how to fetch a missing corpus', () => {
    expect(() => readCorpus(join(dir, 'missing'))).toThrow(/fetch\.ts/);
  });
});
