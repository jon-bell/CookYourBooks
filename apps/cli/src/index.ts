#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { loadConfig, requireConfig, saveConfig } from './config.js';
import { exportLibrary, importRecipe, type ExportedRecipe } from './api.js';

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
