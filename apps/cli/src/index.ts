#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Command, InvalidArgumentError } from 'commander';

import pkg from '../package.json' with { type: 'json' };
import {
  type CookbookEntry,
  type CookbookMetadata,
  type ExportedRecipe,
  exportLibrary,
  exportToc,
  importCookbook,
  importRecipe,
  importToc,
  type TocCollection,
} from './api.js';
import { loadConfig, requireConfig, saveConfig } from './config.js';
import { readCorpus } from './demo/corpus.js';
import { type BookResult, loadBook } from './demo/load.js';
import { signIn } from './demo/session.js';

const program = new Command();

program.name('cyb').description('CookYourBooks command-line client').version(pkg.version);

program
  .command('login')
  .description('Store Supabase connection info + CLI token')
  .requiredOption('--url <url>', 'Supabase project URL')
  .requiredOption('--anon-key <key>', 'Supabase anon (publishable) key')
  .requiredOption('--token <token>', 'CLI token minted in Settings → CLI tokens')
  .action((opts: { url: string; anonKey: string; token: string }) => {
    if (!opts.token.startsWith('cyb_cli_')) {
      exitWith(`Refusing to save: tokens must start with "cyb_cli_".`);
    }
    const path = saveConfig({ url: opts.url, anonKey: opts.anonKey, token: opts.token });
    console.log(`Saved credentials to ${path}`);
  });

program
  .command('whoami')
  .description('Show the currently-configured connection')
  .action(() => {
    const config = loadConfig();
    if (!config) exitWith('Not logged in.');
    console.log(`URL:   ${config.url}`);
    console.log(`Token: ${config.token.slice(0, 12)}…`);
  });

program
  .command('export')
  .description('Dump the whole library as JSON')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .option('--pretty', 'Pretty-print the JSON')
  .action(async (opts: { output?: string; pretty?: boolean }) => {
    const config = requireConfig();
    const data = await exportLibrary(config);
    const text = opts.pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    if (opts.output) {
      writeFileSync(opts.output, text + '\n');
      console.error(
        `Wrote ${data.collections.length} collection(s), ` +
          `${data.collections.reduce((n, c) => n + c.recipes.length, 0)} recipe(s) to ${opts.output}`,
      );
    } else {
      process.stdout.write(text + '\n');
    }
  });

program
  .command('import')
  .description('Import a recipe (or collection of recipes) from a JSON file')
  .argument('<file>', 'Path to a JSON file — either a single recipe or a collections-export blob')
  .option(
    '--collection <id>',
    'Target collection UUID. If omitted, recipes land in an auto-created "CLI imports" collection.',
  )
  .action(async (file: string, opts: { collection?: string }) => {
    const config = requireConfig();
    const raw = readFileSync(file, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      exitWith(`${file}: not valid JSON (${(e as Error).message})`);
    }

    const recipes = extractRecipes(parsed);
    if (recipes.length === 0) exitWith(`${file}: no recipes found.`);

    let imported = 0;
    for (const recipe of recipes) {
      try {
        const newId = await importRecipe(config, recipe, opts.collection);
        console.error(`+ ${recipe.title}  →  ${newId}`);
        imported += 1;
      } catch (e) {
        console.error(`! ${recipe.title}  →  ${(e as Error).message}`);
      }
    }
    console.error(`Imported ${imported}/${recipes.length} recipe(s).`);
    if (imported === 0) process.exit(1);
  });

const tocCommand = program
  .command('toc')
  .description('Work with cookbook tables of contents (titles only)');

tocCommand
  .command('export')
  .description('Dump collection ToCs — titles, not full recipes')
  .option('--collection <id>', 'Scope to one collection; default dumps every collection')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .option('--pretty', 'Pretty-print the JSON')
  .option('--format <format>', 'Output format: "json" (default) or "text"', 'json')
  .action(
    async (opts: { collection?: string; output?: string; pretty?: boolean; format: string }) => {
      const config = requireConfig();
      const data = await exportToc(config, opts.collection);
      const format = opts.format.toLowerCase();
      if (format !== 'json' && format !== 'text') {
        exitWith(`Unknown format "${opts.format}". Use "json" or "text".`);
      }

      const text =
        format === 'text'
          ? renderTocAsText(data.collections)
          : (opts.pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)) + '\n';

      if (opts.output) {
        writeFileSync(opts.output, text);
        const recipeCount = data.collections.reduce((n, c) => n + c.recipes.length, 0);
        console.error(
          `Wrote ToC for ${data.collections.length} collection(s), ${recipeCount} recipe(s) to ${opts.output}`,
        );
      } else {
        process.stdout.write(text);
      }
    },
  );

tocCommand
  .command('import-cookbooks')
  .description('Bulk-import Eat Your Books-style ToC JSON files as new cookbook collections')
  .argument('<paths...>', 'JSON files and/or directories containing *.json ToC dumps')
  .action(async (paths: string[]) => {
    const config = requireConfig();
    const files = expandTocInputs(paths);
    if (files.length === 0) exitWith('No JSON files found in the given paths.');

    let created = 0;
    let reused = 0;
    let totalImported = 0;
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        console.error(`! ${file}: not valid JSON (${(e as Error).message})`);
        continue;
      }

      const parsedBook = parseCookbookFile(parsed);
      if (!parsedBook) {
        console.error(`! ${file}: no cookbook metadata / recipes found`);
        continue;
      }
      if (parsedBook.truncated) {
        console.error(
          `  ${file}: source reports more recipes than are in the file — ` +
            `importing only the ${parsedBook.entries.length} included`,
        );
      }

      try {
        const result = await importCookbook(config, parsedBook.metadata, parsedBook.entries);
        if (result.reused) {
          reused += 1;
          console.error(
            `= ${parsedBook.metadata.title} — already imported (${result.collection_id}), ` +
              `skipped ${result.skipped} entries`,
          );
        } else {
          created += 1;
          totalImported += result.imported;
          console.error(
            `+ ${parsedBook.metadata.title} → ${result.collection_id} ` +
              `(${result.imported} recipe${result.imported === 1 ? '' : 's'})`,
          );
        }
      } catch (e) {
        console.error(`! ${parsedBook.metadata.title}: ${(e as Error).message}`);
      }
    }
    console.error(
      `Processed ${files.length} file(s): ${created} new cookbook(s), ` +
        `${reused} already present, ${totalImported} recipe(s) imported.`,
    );
    if (created === 0 && reused === 0) process.exit(1);
  });

tocCommand
  .command('import')
  .description('Seed placeholder recipes (title only) into a collection from a list')
  .argument('<file>', 'Plain text (one title per line, blank lines + "#" comments ignored) or JSON')
  .requiredOption('--collection <id>', 'Target collection UUID')
  .action(async (file: string, opts: { collection: string }) => {
    const config = requireConfig();
    const raw = readFileSync(file, 'utf8');
    const titles = parseTocTitles(raw, file);
    if (titles.length === 0) exitWith(`${file}: no titles found.`);

    const ids = await importToc(config, opts.collection, titles);
    for (let i = 0; i < ids.length; i += 1) {
      console.error(`+ ${titles[i]}  →  ${ids[i]}`);
    }
    console.error(`Imported ${ids.length} placeholder recipe(s).`);
    if (ids.length === 0) process.exit(1);
  });

const demoCommand = program
  .command('demo')
  .description('Load demo content into an account (signs in as that user; see apps/cli/README.md)');

demoCommand
  .command('load')
  .description(
    'Push a demo-content corpus (scripts/demo-content/out) through the OCR import pipeline ' +
      'and auto-accept the clean recipes',
  )
  .argument('[dir]', 'Corpus directory', 'scripts/demo-content/out')
  .option('--only <ids>', 'Comma-separated book ids (folder names) to load')
  .option('--max-recipes <n>', 'At most this many recipes per book', parsePositiveInt)
  .option('--email <email>', 'Account to load into (or $CYB_EMAIL)')
  .option('--password-env <var>', 'Env var holding the password', 'CYB_PASSWORD')
  .option('--url <url>', 'Supabase URL (or $CYB_SUPABASE_URL, or the `cyb login` config)')
  .option('--anon-key <key>', 'Supabase anon key (or $CYB_SUPABASE_ANON_KEY, or the config)')
  .option(
    '--provider <provider>',
    "Override the account's OCR provider (gemini | openai-compatible)",
  )
  .option('--model <model>', "Override the account's OCR model")
  .option('--no-accept', 'Leave OCR results on the batch board for manual review')
  .option('--no-wait', 'Queue the batches and exit without waiting for OCR')
  .option('--timeout <minutes>', 'Per-book wait limit', parsePositiveInt, 20)
  .option('--force', "Upload again even if the book's batch already exists")
  .option('--dry-run', 'List what would be loaded, then exit')
  .action(
    async (
      dir: string,
      opts: {
        only?: string;
        maxRecipes?: number;
        email?: string;
        passwordEnv: string;
        url?: string;
        anonKey?: string;
        provider?: string;
        model?: string;
        accept: boolean;
        wait: boolean;
        timeout: number;
        force?: boolean;
        dryRun?: boolean;
      },
    ) => {
      if (
        opts.provider !== undefined &&
        opts.provider !== 'gemini' &&
        opts.provider !== 'openai-compatible'
      ) {
        exitWith(`--provider must be "gemini" or "openai-compatible".`);
      }
      const all = readCorpus(
        dir,
        opts.only?.split(',').map((s) => s.trim()),
      );
      // Books with only contents / notes / handwriting sections have no
      // recipe pages to import — skip them rather than create empty cookbooks.
      const books = all.filter((b) => b.recipes.length > 0);
      for (const b of all) {
        const n = Math.min(b.recipes.length, opts.maxRecipes ?? b.recipes.length);
        console.error(
          `${b.id}: ${n > 0 ? `${n} recipe(s)` : 'no recipe pages, skipped'} — ${b.title}`,
        );
      }
      if (books.length === 0) exitWith(`${dir}: no books with recipe pages found.`);
      if (opts.dryRun) return;

      const { client, userId, email } = await signIn(opts);
      console.error(`Signed in as ${email}`);
      const results: BookResult[] = [];
      for (const book of books) {
        console.error(`\n${book.title}`);
        try {
          results.push(
            await loadBook(client, userId, book, {
              maxRecipes: opts.maxRecipes,
              accept: opts.accept,
              wait: opts.wait,
              timeoutMs: opts.timeout * 60_000,
              force: opts.force ?? false,
              provider: opts.provider,
              model: opts.model,
              log: (line) => console.error(line),
            }),
          );
        } catch (e) {
          console.error(`  ! ${(e as Error).message}`);
        }
      }

      console.error('\nbook                             queued  recipes  review  failed  pending');
      for (const r of results) {
        console.error(
          `${r.book.padEnd(32)} ${String(r.uploaded).padStart(6)} ${String(r.recipesCreated).padStart(8)}` +
            ` ${String(r.heldForReview).padStart(7)} ${String(r.failed).padStart(7)} ${String(r.pending).padStart(8)}`,
        );
      }
      await client.auth.signOut();
      if (results.length < books.length) process.exit(1);
    },
  );

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new InvalidArgumentError('Expected a positive integer.');
  return n;
}

/**
 * Render a ToC export as a plain-text file. Each collection gets a
 * "# Title" header; each recipe becomes one line. Round-trippable into
 * `toc import` modulo the comment line, which is stripped there.
 */
function renderTocAsText(collections: TocCollection[]): string {
  const parts: string[] = [];
  for (const c of collections) {
    const author = c.author ? ` — ${c.author}` : '';
    parts.push(`# ${c.title}${author}`);
    for (const r of c.recipes) parts.push(r.title);
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * Pull a list of titles out of either a plain-text file (one per line,
 * `#` comments and blank lines skipped) or a JSON file in one of the
 * shapes we produce/accept: {collections:[{recipes:[{title}]}]},
 * {recipes:[{title}]}, {titles:[...]}, or a bare string[].
 */
function parseTocTitles(raw: string, file: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      exitWith(`${file}: not valid JSON (${(e as Error).message})`);
    }
    return extractTocTitles(parsed);
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function extractTocTitles(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((x) => (typeof x === 'string' ? x : (x as { title?: unknown })?.title))
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
  }
  if (typeof input !== 'object') return [];
  const obj = input as {
    titles?: unknown;
    recipes?: unknown;
    collections?: unknown;
  };
  if (Array.isArray(obj.titles)) return extractTocTitles(obj.titles);
  if (Array.isArray(obj.recipes)) return extractTocTitles(obj.recipes);
  if (Array.isArray(obj.collections)) {
    return obj.collections.flatMap((c) => extractTocTitles((c as { recipes?: unknown }).recipes));
  }
  return [];
}

/**
 * Accept either a raw recipe object or a library-export shape. This is
 * deliberately forgiving because the import file might come from an
 * export, a hand-written dump, or a script.
 */
function extractRecipes(input: unknown): ExportedRecipe[] {
  if (!input || typeof input !== 'object') return [];
  // `cli_export_library` shape: { collections: [{ recipes: [...] }] }
  if (Array.isArray((input as { collections?: unknown[] }).collections)) {
    const collections = (input as { collections: unknown[] }).collections;
    return collections.flatMap((c) => {
      const recs = (c as { recipes?: unknown[] }).recipes;
      return Array.isArray(recs) ? (recs as ExportedRecipe[]) : [];
    });
  }
  // A `{ recipes: [...] }` wrapper (single collection).
  if (Array.isArray((input as { recipes?: unknown[] }).recipes)) {
    return (input as { recipes: ExportedRecipe[] }).recipes;
  }
  // A bare array of recipes.
  if (Array.isArray(input)) return input as ExportedRecipe[];
  // A single recipe.
  if (typeof (input as { title?: unknown }).title === 'string') {
    return [input as ExportedRecipe];
  }
  return [];
}

/**
 * Expand a mixed list of file and directory paths into a sorted list of
 * `.json` files. Directories are shallow-scanned; non-JSON files are
 * dropped silently so a user can point at a grab-bag folder.
 */
function expandTocInputs(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      console.error(`! ${p}: not found`);
      continue;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) {
        if (name.endsWith('.json')) out.push(join(p, name));
      }
    } else if (st.isFile()) {
      out.push(p);
    }
  }
  return out;
}

interface ParsedCookbook {
  metadata: CookbookMetadata;
  entries: CookbookEntry[];
  truncated: boolean;
}

/**
 * Parse an Eat Your Books-style ToC dump into the shape the
 * `cli_import_cookbook` RPC wants. The source format is nested:
 * `bookDetails.book` holds identifying metadata, `bookDetails.authors`
 * is a separate array of {title, id}, and `recipeSearchResults.recipes`
 * is the ToC itself with optional `pageNumber` per entry.
 *
 * Returns null if the input doesn't look like one of these dumps at all
 * — upstream prints a skip message rather than aborting the batch.
 */
function parseCookbookFile(input: unknown): ParsedCookbook | null {
  if (!input || typeof input !== 'object') return null;
  const root = input as {
    bookDetails?: {
      book?: {
        title?: unknown;
        isbn13?: unknown;
        datePublished?: unknown;
      };
      authors?: Array<{ title?: unknown }>;
    };
    recipeSearchResults?: {
      recipes?: Array<{ title?: unknown; pageNumber?: unknown }>;
      hasMore?: unknown;
      recipeCount?: unknown;
    };
  };

  const book = root.bookDetails?.book;
  const recipes = root.recipeSearchResults?.recipes;
  if (!book || !Array.isArray(recipes)) return null;

  const title = typeof book.title === 'string' ? book.title.trim() : '';
  if (!title) return null;

  const authorList = Array.isArray(root.bookDetails?.authors)
    ? root.bookDetails.authors
        .map((a) => (typeof a?.title === 'string' ? a.title.trim() : ''))
        .filter((t) => t.length > 0)
    : [];
  const author = authorList.length > 0 ? authorList.join(', ') : null;

  const isbn =
    typeof book.isbn13 === 'string' && book.isbn13.trim() !== '' ? book.isbn13.trim() : null;

  let publicationYear: number | null = null;
  if (typeof book.datePublished === 'string') {
    const match = book.datePublished.match(/^(\d{4})/);
    if (match) publicationYear = Number(match[1]);
  }

  const entries: CookbookEntry[] = [];
  for (const r of recipes) {
    const recipeTitle = typeof r?.title === 'string' ? r.title.trim() : '';
    if (!recipeTitle) continue;
    const page =
      typeof r?.pageNumber === 'number' && Number.isFinite(r.pageNumber) ? r.pageNumber : null;
    entries.push({ title: recipeTitle, page_number: page });
  }

  const truncated = root.recipeSearchResults?.hasMore === true;

  return {
    metadata: {
      title,
      author,
      isbn,
      publication_year: publicationYear,
      source_type: 'PUBLISHED_BOOK',
    },
    entries,
    truncated,
  };
}

function exitWith(message: string): never {
  console.error(message);
  process.exit(1);
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : JSON.stringify(err));
  process.exit(1);
});
