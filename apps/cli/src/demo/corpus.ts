import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Reader for the demo-content corpus written by scripts/demo-content/fetch.ts:
//
//   <dir>/<book-id>/source.json            title, author, year, collection kind
//   <dir>/<book-id>/pages/<recipe>/NN-*.jpg the page(s) one recipe spans, in order
//   <dir>/<book-id>/pages.json              printed page per scan leaf (optional)
//
// Only the recipe page folders are loaded; contents / index / notes pages and
// the whole-book transcriptions are ignored here.

export type DemoCollectionKind = 'cookbook' | 'personal' | 'web';

export interface DemoRecipe {
  /** Folder name, e.g. "risotto-milanaise". */
  slug: string;
  /** Absolute paths to the page images, in reading order. */
  pages: string[];
  /** The printed page numbers of those pages (from pages.json), when every
   *  one is known — exact, unlike the OCR model's guess. */
  printedPages?: number[];
}

export interface DemoBook {
  id: string;
  title: string;
  author: string | null;
  year: number | null;
  collection: DemoCollectionKind;
  recipes: DemoRecipe[];
}

const IMAGE = /\.(jpe?g|png)$/i;

export function readCorpus(dir: string, only?: readonly string[]): DemoBook[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(
      `${dir}: not a directory. Fetch the corpus first:\n` +
        `  deno run --allow-net --allow-read --allow-write --allow-run scripts/demo-content/fetch.ts --images`,
    );
  }
  const wanted = only && only.length > 0 ? new Set(only) : null;
  const books: DemoBook[] = [];
  for (const id of readdirSync(dir).sort()) {
    if (wanted && !wanted.has(id)) continue;
    const bookDir = join(dir, id);
    const sourcePath = join(bookDir, 'source.json');
    if (!existsSync(sourcePath)) continue;
    const book = parseBook(id, JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown);
    const pageMap = readPageMap(join(bookDir, 'pages.json'));
    const pagesDir = join(bookDir, 'pages');
    if (existsSync(pagesDir)) {
      for (const slug of readdirSync(pagesDir).sort()) {
        const recipeDir = join(pagesDir, slug);
        if (!statSync(recipeDir).isDirectory()) continue;
        const pages = readdirSync(recipeDir)
          .filter((f) => IMAGE.test(f))
          .sort()
          .map((f) => join(recipeDir, f));
        if (pages.length === 0) continue;
        const printed = pages.map((f) => pageMap.get(/leaf(\d+)/.exec(f)?.[1] ?? ''));
        book.recipes.push({
          slug,
          pages,
          printedPages: printed.every((n) => n !== undefined) ? printed : undefined,
        });
      }
    }
    books.push(book);
  }
  if (wanted) {
    const missing = [...wanted].filter((id) => !books.some((b) => b.id === id));
    if (missing.length > 0) throw new Error(`not in ${dir}: ${missing.join(', ')}`);
  }
  return books;
}

/** pages.json: `{ "<leaf>": <printed page> }`. Missing or malformed → empty. */
function readPageMap(path: string): Map<string, number> {
  if (!existsSync(path)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return new Map(
      Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number'),
    );
  } catch {
    return new Map();
  }
}

function parseBook(id: string, raw: unknown): DemoBook {
  const src = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const kind = src.collection;
  return {
    id,
    title: str(src.title) ?? id,
    author: str(src.author),
    year: typeof src.year === 'number' ? src.year : null,
    collection: kind === 'personal' || kind === 'web' ? kind : 'cookbook',
    recipes: [],
  };
}
