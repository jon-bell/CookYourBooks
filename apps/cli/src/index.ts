#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { loadConfig, requireConfig, saveConfig } from './config.js';
import {
  exportLibrary,
  exportToc,
  importRecipe,
  importToc,
  type ExportedRecipe,
  type TocCollection,
} from './api.js';

const program = new Command();

program
  .name('cyb')
  .description('CookYourBooks command-line client')
  .version('0.0.0');

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
    return obj.collections.flatMap((c) =>
      extractTocTitles((c as { recipes?: unknown }).recipes),
    );
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

function exitWith(message: string): never {
  console.error(message);
  process.exit(1);
}

program.parseAsync(process.argv).catch((err) => {
  console.error((err as Error).message ?? String(err));
  process.exit(1);
});
