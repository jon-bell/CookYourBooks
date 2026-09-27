// deno run --allow-net --allow-read --allow-write --allow-run \
//   scripts/demo-content/fetch.ts [--only id,id] [--text] [--images] [--bulk] [--width N] [--force]
//
// Collects the public-domain demo corpus described in ./sources.ts into
// scripts/demo-content/out/ (gitignored). Two shapes of output, so the same
// books can demo both import paths:
//
//   out/<book>/text/         whole-book transcriptions (Gutenberg) and, for
//                            PDF sources, one .txt per recipe from the PDF's
//                            text layer — paste-able into the text importer.
//   out/<book>/pages/<slug>/ page images for one recipe, in reading order —
//                            drop the folder into the OCR import board.
//   out/<book>/bulk/<label>/ a chapter-sized run of pages (--bulk only) for
//                            the "scan a whole chapter" demo.
//   out/<book>/cover.jpg     first scan leaf / first PDF page.
//   out/<book>/source.json   title, author, year, rights basis, and an index
//                            of every file written — the provenance record.
//
// Flags:
//   --only a,b    just these book ids (see sources.ts)
//   --text        only transcriptions / PDF text   (default: text + images)
//   --images      only page images                 (default: text + images)
//   --bulk        also fetch the bulk chapter ranges (tens of pages each)
//   --width N     IA page image width in px (default 1600; the scans are
//                 ~1800 native, and 1600 keeps OCR accuracy at ~1/3 the bytes)
//   --force       re-download files that already exist
//
// Re-runs are incremental: existing files are skipped unless --force.
// PDF sources need poppler (`pdftotext`, `pdftoppm`) on PATH.

import { BOOKS, type Book, type PdfRecipe } from './sources.ts';

const OUT = new URL('./out/', import.meta.url).pathname;
const UA = 'CookYourBooks-demo-content/1.0 (+https://cookyourbooks.app)';

interface Opts {
  only: Set<string> | null;
  text: boolean;
  images: boolean;
  bulk: boolean;
  width: number;
  force: boolean;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { only: null, text: false, images: false, bulk: false, width: 1600, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') o.only = new Set(argv[++i].split(','));
    else if (a === '--text') o.text = true;
    else if (a === '--images') o.images = true;
    else if (a === '--bulk') o.bulk = true;
    else if (a === '--width') o.width = Number(argv[++i]);
    else if (a === '--force') o.force = true;
    else {
      console.error(`unknown argument: ${a}`);
      Deno.exit(2);
    }
  }
  if (!o.text && !o.images) o.text = o.images = true;
  if (o.only) {
    const known = new Set(BOOKS.map((b) => b.id));
    const bad = [...o.only].filter((id) => !known.has(id));
    if (bad.length) {
      console.error(`unknown book id(s): ${bad.join(', ')}\nknown: ${[...known].join(', ')}`);
      Deno.exit(2);
    }
  }
  return o;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** GET with retry. IA in particular throws the odd 5xx / reset under load. */
async function download(url: string, dest: string, force: boolean): Promise<'hit' | 'fetched'> {
  if (!force && (await exists(dest))) return 'hit';
  await Deno.mkdir(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        await res.body?.cancel();
        // 4xx won't get better on retry.
        if (res.status < 500) throw new Error(`HTTP ${res.status} for ${url}`);
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        continue;
      }
      // Write to a temp name first so a killed run never leaves a truncated
      // file that the next run would treat as a cache hit.
      const tmp = `${dest}.part`;
      await Deno.writeFile(tmp, new Uint8Array(await res.arrayBuffer()));
      await Deno.rename(tmp, dest);
      return 'fetched';
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && /HTTP 4\d\d/.test(e.message)) break;
    }
  }
  throw lastErr;
}

/** Run `fn` over `items` with at most `n` in flight — polite to IA. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
    }),
  );
}

async function run(cmd: string, args: string[]): Promise<string> {
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(cmd, { args, stdout: 'piped', stderr: 'piped' }).output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`\`${cmd}\` not found — PDF sources need poppler (apt install poppler-utils / brew install poppler)`);
    }
    throw e;
  }
  if (!out.success) throw new Error(`${cmd} ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout);
}

// ── Internet Archive ────────────────────────────────────────────────────

/**
 * IA's page-image endpoint (`/page/n<k>.jpg`) indexes the scan's *access*
 * pages from 0, while search-inside and sources.ts speak leaf numbers. The
 * two don't line up by a fixed offset: some scans number leaves from 0,
 * others from 1 with a hidden colour-card leaf 0 in front. So build the map
 * from the scan's own manifest — scandata.xml (access pages in order), or
 * failing that page_numbers.json (which lists the same pages).
 */
async function iaLeafIndex(identifier: string): Promise<Map<number, number>> {
  const meta = await (await fetch(`https://archive.org/metadata/${identifier}`, { headers: { 'User-Agent': UA } })).json();
  if (!meta.server) throw new Error(`no such IA item: ${identifier}`);
  const base = `https://${meta.server}${meta.dir}/${identifier}`;
  let leaves: number[] = [];
  const sd = await fetch(`${base}_scandata.xml`, { headers: { 'User-Agent': UA } });
  if (sd.ok) {
    for (const m of (await sd.text()).matchAll(/<page leafNum="(\d+)">([\s\S]*?)<\/page>/g)) {
      if (!/<addToAccessFormats>false</.test(m[2])) leaves.push(Number(m[1]));
    }
  } else await sd.body?.cancel();
  if (!leaves.length) {
    const pn = await fetch(`${base}_page_numbers.json`, { headers: { 'User-Agent': UA } });
    if (pn.ok) leaves = ((await pn.json()) as { pages: { leafNum: number }[] }).pages.map((p) => p.leafNum);
    else await pn.body?.cancel();
  }
  if (!leaves.length) throw new Error(`${identifier}: no scandata.xml or page_numbers.json to map leaves → page images`);
  return new Map(leaves.map((leaf, n) => [leaf, n]));
}

function iaPageUrl(identifier: string, n: number, width: number): string {
  return `https://archive.org/download/${identifier}/page/n${n}_w${width}.jpg`;
}

async function fetchScans(book: Book, dir: string, o: Opts) {
  const ia = book.ia;
  if (!ia) return;
  const index = await iaLeafIndex(ia.identifier);
  const page = (leaf: number) => {
    const n = index.get(leaf);
    if (n === undefined) throw new Error(`${ia.identifier}: leaf ${leaf} is not an access page`);
    return iaPageUrl(ia.identifier, n, o.width);
  };
  const jobs: { url: string; dest: string }[] = [];
  // First access page: the cover on most scans (a library/Google title sheet on some).
  jobs.push({ url: iaPageUrl(ia.identifier, 0, o.width), dest: `${dir}/cover.jpg` });
  for (const r of ia.recipes) {
    const slug = slugify(r.title);
    r.leaves.forEach((leaf, i) => {
      jobs.push({
        url: page(leaf),
        dest: `${dir}/pages/${slug}/${pad(i + 1)}-leaf${leaf}.jpg`,
      });
    });
  }
  if (o.bulk) {
    for (const range of ia.bulk ?? []) {
      for (let leaf = range.from; leaf <= range.to; leaf++) {
        jobs.push({
          url: page(leaf),
          dest: `${dir}/bulk/${range.label}/${pad(leaf - range.from + 1, 3)}-leaf${leaf}.jpg`,
        });
      }
    }
  }
  let fetched = 0;
  await pool(jobs, 4, async (j) => {
    if ((await download(j.url, j.dest, o.force)) === 'fetched') fetched++;
  });
  console.log(`  scans: ${jobs.length} pages (${fetched} downloaded) from archive.org/details/${ia.identifier}`);
}

// ── Born-digital PDFs ───────────────────────────────────────────────────

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Find each recipe's page(s) by the title printed at the top of the page.
 * `pages` is pdftotext's reading-order (non-layout) text, which is messy in
 * two known ways: a wrapped title can have the "Prep time:" sidebar spliced
 * into it (Dinners), and decorative banner text ("THE CLASSICS") can come
 * first (Family Meals). So: the title phrase near the top, or its first
 * three words at the very start with every title word nearby. Contents and
 * chapter-divider pages list titles too; they're the ones with bullets or
 * dot leaders. A recipe that runs over continues on pages headed
 * "<title> (continued)". Titles set as artwork aren't in the text layer at
 * all — give those explicit `pages` in sources.ts.
 */
function locatePdfRecipes(pages: string[], recipes: PdfRecipe[]): Map<string, number[]> {
  const heads = pages.map((p) => norm(p).slice(0, 300));
  const isListing = (h: string) => h.includes('•') || h.includes('....');
  const found = new Map<string, number[]>();
  for (const r of recipes) {
    if (typeof r !== 'string') {
      found.set(r.title, r.pages);
      continue;
    }
    const phrase = norm(r);
    const words = phrase.split(' ');
    const lead = words.slice(0, 3).join(' ');
    const mentions = (h: string) => h.includes(phrase) || (h.startsWith(lead) && words.every((w) => h.includes(w)));
    const start = heads.findIndex((h) => !isListing(h) && !h.includes('(continued)') && mentions(h));
    if (start < 0) {
      console.warn(`  ! pdf: no page headed "${r}" — check the title, or pin it with { title, pages }`);
      continue;
    }
    const nums = [start + 1];
    for (let i = start + 1; i < heads.length && heads[i].includes('(continued)') && heads[i].includes(lead); i++) {
      nums.push(i + 1);
    }
    found.set(r, nums);
  }
  return found;
}

async function fetchPdf(book: Book, dir: string, o: Opts) {
  const pdf = book.pdf;
  if (!pdf) return;
  const src = `${dir}/source.pdf`;
  const hit = await download(pdf.url, src, o.force);
  console.log(`  pdf: ${hit === 'hit' ? 'cached' : 'downloaded'} ${pdf.url}`);

  // Form feeds separate pages. Reading-order text to find recipes; layout
  // text to write them out (keeps the ingredient / step columns apart).
  const located = locatePdfRecipes((await run('pdftotext', [src, '-'])).split('\f'), pdf.recipes);
  const pages = (await run('pdftotext', ['-layout', src, '-'])).split('\f');

  if (o.images) {
    const cover = `${dir}/cover.jpg`;
    if (o.force || !(await exists(cover))) {
      await run('pdftoppm', ['-jpeg', '-r', '100', '-f', '1', '-l', '1', '-singlefile', src, cover.replace(/\.jpg$/, '')]);
    }
  }
  for (const [title, nums] of located) {
    const slug = slugify(title);
    if (o.text) {
      const rel = `text/${slug}.txt`;
      await Deno.mkdir(`${dir}/text`, { recursive: true });
      await Deno.writeTextFile(`${dir}/${rel}`, nums.map((n) => pages[n - 1].trimEnd()).join('\n\n') + '\n');
    }
    if (o.images) {
      await Deno.mkdir(`${dir}/pages/${slug}`, { recursive: true });
      for (const [i, n] of nums.entries()) {
        const rel = `pages/${slug}/${pad(i + 1)}-p${n}.jpg`;
        if (o.force || !(await exists(`${dir}/${rel}`))) {
          // 150 dpi: legible for OCR, and the photos still look good in a deck.
          await run('pdftoppm', [
            '-jpeg', '-r', '150', '-f', String(n), '-l', String(n), '-singlefile',
            src, `${dir}/${rel}`.replace(/\.jpg$/, ''),
          ]);
        }
      }
    }
  }
  console.log(`  pdf: ${located.size}/${pdf.recipes.length} recipes located`);
}

// ── Transcriptions ──────────────────────────────────────────────────────

async function fetchText(book: Book, dir: string, o: Opts) {
  for (const t of book.text ?? []) {
    const rel = `text/${t.name}`;
    const hit = await download(t.url, `${dir}/${rel}`, o.force);
    console.log(`  text: ${hit === 'hit' ? 'cached' : 'downloaded'} ${t.url}`);
  }
}

/** Everything on disk for a book, grouped by folder — rebuilt each run so a
 *  partial run (--text only) doesn't drop what an earlier run fetched. */
async function indexDir(dir: string): Promise<Record<string, string[]>> {
  const index: Record<string, string[]> = {};
  async function walk(rel: string) {
    for await (const e of Deno.readDir(rel ? `${dir}/${rel}` : dir)) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(path);
      else if (path !== 'source.json' && !path.endsWith('.part')) (index[rel || '.'] ??= []).push(path);
    }
  }
  await walk('');
  for (const k of Object.keys(index)) index[k].sort();
  return Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const o = parseArgs(Deno.args);
  const books = BOOKS.filter((b) => !o.only || o.only.has(b.id));
  const failures: string[] = [];
  for (const book of books) {
    console.log(`${book.id} — ${book.title} (${book.author}, ${book.year})`);
    const dir = `${OUT}${book.id}`;
    await Deno.mkdir(dir, { recursive: true });
    // Each step fails independently: one flaky host shouldn't cost the rest.
    const steps: [boolean, typeof fetchText][] = [
      [o.text, fetchText],
      [o.images, fetchScans],
      [o.text || o.images, fetchPdf],
    ];
    for (const [enabled, step] of steps) {
      if (!enabled) continue;
      try {
        await step(book, dir, o);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  ✗ ${step.name}: ${msg}`);
        failures.push(`${book.id}/${step.name}: ${msg}`);
      }
    }
    const { text: _t, ia, pdf, ...meta } = book;
    await Deno.writeTextFile(
      `${dir}/source.json`,
      JSON.stringify(
        {
          ...meta,
          scan: ia ? `https://archive.org/details/${ia.identifier}` : undefined,
          pdf: pdf?.url,
          fetchedAt: new Date().toISOString(),
          files: await indexDir(dir),
        },
        null,
        2,
      ) + '\n',
    );
  }
  console.log(`\nwrote ${OUT}`);
  if (failures.length) {
    console.error(`\n${failures.length} step(s) failed — re-run to retry (downloads are incremental):`);
    for (const f of failures) console.error(`  ${f}`);
    Deno.exit(1);
  }
}

if (import.meta.main) await main();
