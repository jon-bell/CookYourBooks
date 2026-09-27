// The import-flow half of the screenshot driver: takes demo-content page
// scans (served by the host from scripts/demo-content/out) through the real
// "Choose images" import — picker, upload, OCR board, review — and leaves the
// batch board open while the app's own auto-accept pass files the recipes, so
// the run genuinely imports them into the demo account.
//
// Steps (see ScreenshotStep in driver.ts):
//   import-select  find/create the book's cookbook, open /import/new with it
//                  preselected, and attach the pages to the file input
//   import-start   press "Start import" and land on the batch board
//   import-wait    wait for OCR to drain and auto-accept to file the recipes
//   import-item    open the first page's review screen
//   import-recipe  open the first recipe the import created

import { createCookbook, createPersonalCollection } from '@cookyourbooks/domain';

import { collectionRepo } from '../data/repos.js';
import { supabase } from '../supabase.js';
import { navigate, sleep, waitUntil } from './dom.js';
import type { Host, ScreenshotStep } from './driver.js';

export interface ImportContext {
  collectionId?: string;
  batchId?: string;
}

interface CorpusBook {
  id: string;
  title: string;
  author: string | null;
  year: number | null;
  collection: 'cookbook' | 'personal' | 'web';
  /** Page paths are relative to the corpus root, for GET /asset/<path>. */
  recipes: { slug: string; pages: string[] }[];
}

interface ItemRow {
  id: string;
  status: string;
  page_index: number;
  created_recipe_ids: string[];
}

const IN_FLIGHT = new Set(['PENDING', 'CLAIMED']);

export async function runImportAction(
  step: ScreenshotStep,
  ctx: ImportContext,
  host: Host,
): Promise<boolean> {
  switch (step.do) {
    case 'import-select':
      return selectPages(step, ctx, host);
    case 'import-start':
      return startImport(ctx, host);
    case 'import-wait':
      return waitForImport(ctx, host);
    case 'import-item': {
      const first = (await listItems(ctx))[0];
      if (!ctx.batchId || !first) return false;
      navigate(`/import/${ctx.batchId}/items/${first.id}`);
      return true;
    }
    case 'import-recipe': {
      const recipeId = (await listItems(ctx)).flatMap((i) => i.created_recipe_ids)[0];
      if (!ctx.collectionId || !recipeId) return false;
      navigate(`/collections/${ctx.collectionId}/recipes/${recipeId}`);
      return true;
    }
    default:
      host.log(`unknown action ${String(step.do)}`);
      return false;
  }
}

async function selectPages(step: ScreenshotStep, ctx: ImportContext, host: Host) {
  if (!step.book) return false;
  let book: CorpusBook;
  try {
    book = (await host.call('GET', `/corpus/${encodeURIComponent(step.book)}`)) as CorpusBook;
  } catch (e) {
    host.log(`no demo corpus for ${step.book} (${(e as Error).message})`);
    return false;
  }
  const recipes = step.recipes
    ? book.recipes.filter((r) => step.recipes!.includes(r.slug))
    : book.recipes;
  if (recipes.length === 0) return false;

  const { data } = await supabase.auth.getUser();
  if (!data.user) return false;
  ctx.collectionId = await ensureCollection(data.user.id, book);

  const files: File[] = [];
  for (const r of recipes) {
    for (const [i, page] of r.pages.entries()) {
      const blob = await host.blob(`/asset/${page}`, 'image/jpeg');
      files.push(new File([blob], `${r.slug}-${i + 1}.jpg`, { type: 'image/jpeg' }));
    }
  }
  host.log(`import-select: ${files.length} page(s) from ${book.id}`);

  navigate(`/import/new?collection=${ctx.collectionId}`);
  const input = await waitFor(() =>
    document.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"]'),
  );
  if (!input) return false;
  // The same thing a picker does: hand the input a FileList, fire `change`.
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  if (!(await waitFor(() => startButton()))) return false;
  setFieldValue('Batch name', book.title);
  return true;
}

async function startImport(ctx: ImportContext, host: Host) {
  const button = startButton();
  if (!button) return false;
  button.click();
  // Upload time dominates: every page goes to Storage before the board opens.
  const landed = await waitUntil(
    'batch board',
    () => /^\/import\/[0-9a-f-]{36}$/.test(window.location.pathname),
    180_000,
    host.log,
  );
  if (!landed) return false;
  ctx.batchId = window.location.pathname.split('/')[2];
  host.log(`import-start: batch ${ctx.batchId}`);
  // Let the first thumbnails paint while OCR is still running.
  await sleep(2500);
  return true;
}

async function waitForImport(ctx: ImportContext, host: Host) {
  if (!ctx.batchId) return false;
  await waitUntil(
    'OCR to finish',
    async () => (await listItems(ctx)).every((i) => !IN_FLIGHT.has(i.status)),
    15 * 60_000,
    host.log,
    3000,
  );
  // Auto-accept runs on the open board as results sync in; give it a moment
  // to file the clean pages (REVIEWED) before the shot.
  await waitUntil(
    'auto-accept',
    async () => (await listItems(ctx)).every((i) => i.status !== 'OCR_DONE'),
    45_000,
    host.log,
    2000,
  );
  const items = await listItems(ctx);
  const created = items.reduce((n, i) => n + i.created_recipe_ids.length, 0);
  host.log(`import-wait: ${items.length} page(s), ${created} recipe(s) imported`);
  return true;
}

async function listItems(ctx: ImportContext): Promise<ItemRow[]> {
  if (!ctx.batchId) return [];
  const { data, error } = await supabase
    .from('import_items')
    .select('id, status, page_index, created_recipe_ids')
    .eq('batch_id', ctx.batchId)
    .order('page_index');
  if (error) return [];
  return data;
}

async function ensureCollection(ownerId: string, book: CorpusBook): Promise<string> {
  const repo = collectionRepo(ownerId);
  const existing = (await repo.listPickerOptions()).find((o) => o.title === book.title);
  if (existing) return existing.id;
  const collection =
    book.collection === 'personal'
      ? createPersonalCollection({ title: book.title })
      : createCookbook({
          title: book.title,
          author: book.author ?? undefined,
          publicationYear: book.year ?? undefined,
        });
  await repo.save(collection);
  return collection.id;
}

function startButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent.trim() === 'Start import' && !b.disabled,
  );
}

/** Set a React-controlled input by its <Field> label: go through the native
 *  value setter so React's onChange sees the edit. */
function setFieldValue(label: string, value: string) {
  const field = Array.from(document.querySelectorAll('label')).find((l) =>
    l.querySelector('span')?.textContent.trim().startsWith(label),
  );
  const input = field?.querySelector('input');
  if (!input) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function waitFor<T>(find: () => T | null | undefined, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = find();
    if (hit) return hit;
    await sleep(200);
  }
  return undefined;
}
