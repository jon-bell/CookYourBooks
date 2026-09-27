// deno run --allow-net --allow-read --allow-write \
//   scripts/demo-content/fetch.ts [--only id,id] [--text] [--images] [--bulk] [--width N] [--force]
//
// Collects the rights-cleared demo corpus described in ./sources.ts into
// scripts/demo-content/out/ (gitignored). Two shapes of output, so the same
// books can demo both import paths:
//
//   out/<book>/text/book.txt   whole-book transcription (Project Gutenberg,
//                              license/trademark header+footer stripped) —
//                              paste-able into the text importer.
//   out/<book>/pages/<slug>/   page images for one recipe, in reading order —
//                              drop the folder into the OCR import board.
//   out/<book>/bulk/<label>/   a chapter-sized run of pages (--bulk only) for
//                              the "scan a whole chapter" demo.
//   out/<book>/<kind>/<label>/ non-recipe example pages: contents, index,
//                              blank-notes, handwritten (sources.ts `sections`).
//   out/<book>/cover.jpg       first page of the scan.
//   out/<book>/source.json     title, author, year, rights and scan terms, and
//                              an index of every file — the provenance record.
//
// Flags:
//   --only a,b    just these book ids (see sources.ts)
//   --text        only transcriptions   (default: text + images)
//   --images      only page images      (default: text + images)
//   --bulk        also fetch the bulk chapter ranges (tens of pages each)
//   --width N     IA page image width in px (default 1600; the scans are
//                 ~1800 native, and 1600 keeps OCR accuracy at ~1/3 the bytes)
//   --force       re-download files that already exist
//
// Re-runs are incremental: existing files are skipped unless --force.
//
// out/ mirrors the manifest. A full run (no --only / --text / --images)
// deletes every file sources.ts no longer produces — including whole books —
// so a source pulled for rights reasons can't linger on anyone's disk.
// (Without --bulk, bulk pages still in the manifest are kept, not fetched.)

import { BOOKS, type Book } from './sources.ts';

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

/**
 * Which URL each file under out/<book>/ was downloaded from. A file only
 * counts as a cache hit if it came from the URL the manifest names *now* —
 * otherwise swapping a book to a different scan (as when a Google scan was
 * replaced for rights reasons) would silently keep the old scan's files at
 * any path the two share, like cover.jpg.
 */
type Ledger = Record<string, string>;
const LEDGER = '.fetched.json';

async function readLedger(dir: string): Promise<Ledger> {
  try {
    return JSON.parse(await Deno.readTextFile(`${dir}/${LEDGER}`));
  } catch {
    return {};
  }
}

/** GET with retry. IA in particular throws the odd 5xx / reset under load. */
async function download(
  url: string,
  dest: string,
  force: boolean,
  ledger?: { entries: Ledger; key: string },
): Promise<'hit' | 'fetched'> {
  const fresh = ledger ? ledger.entries[ledger.key] === url : true;
  if (!force && fresh && (await exists(dest))) return 'hit';
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
      if (ledger) ledger.entries[ledger.key] = url;
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

// ── Internet Archive ────────────────────────────────────────────────────

/**
 * IA's page-image endpoint (`/page/n<k>.jpg`) indexes the scan's *access*
 * pages from 0, while search-inside and sources.ts speak leaf numbers. The
 * two don't line up by a fixed offset: some scans number leaves from 0,
 * others from 1 with a hidden colour-card leaf 0 in front. So build the map
 * from the scan's own manifest — scandata.xml (access pages in order), or
 * failing that page_numbers.json (which lists the same pages). Look both up
 * in the item's file list: user uploads name them after the original file
 * ("Gem Chopper Cook Book_scandata.xml"), not the identifier.
 */
async function iaLeafIndex(identifier: string): Promise<Map<number, number>> {
  const meta = await (await fetch(`https://archive.org/metadata/${identifier}`, { headers: { 'User-Agent': UA } })).json();
  if (!meta.server) throw new Error(`no such IA item: ${identifier}`);
  const base = `https://${meta.server}${meta.dir}/`;
  const named = (suffix: string) => {
    const f = (meta.files as { name: string }[]).find((f) => f.name.endsWith(suffix));
    return f ? base + f.name.split('/').map(encodeURIComponent).join('/') : null;
  };
  let leaves: number[] = [];
  const sdUrl = named('_scandata.xml');
  const sd = sdUrl ? await fetch(sdUrl, { headers: { 'User-Agent': UA } }) : null;
  if (sd?.ok) {
    for (const m of (await sd.text()).matchAll(/<page leafNum="(\d+)">([\s\S]*?)<\/page>/g)) {
      if (!/<addToAccessFormats>false</.test(m[2])) leaves.push(Number(m[1]));
    }
  } else await sd?.body?.cancel();
  const pnUrl = named('_page_numbers.json');
  if (!leaves.length && pnUrl) {
    const pn = await fetch(pnUrl, { headers: { 'User-Agent': UA } });
    if (pn.ok) leaves = ((await pn.json()) as { pages: { leafNum: number }[] }).pages.map((p) => p.leafNum);
    else await pn.body?.cancel();
  }
  if (!leaves.length) throw new Error(`${identifier}: no scandata.xml or page_numbers.json to map leaves → page images`);
  return new Map(leaves.map((leaf, n) => [leaf, n]));
}

function iaPageUrl(identifier: string, n: number, width: number): string {
  return `https://archive.org/download/${identifier}/page/n${n}_w${width}.jpg`;
}

async function fetchScans(book: Book, dir: string, o: Opts, ledger: Ledger): Promise<string[]> {
  const ia = book.ia;
  if (!ia) return [];
  const index = await iaLeafIndex(ia.identifier);
  const page = (leaf: number) => {
    const n = index.get(leaf);
    if (n === undefined) throw new Error(`${ia.identifier}: leaf ${leaf} is not an access page`);
    return iaPageUrl(ia.identifier, n, o.width);
  };
  const jobs: { url: string; dest: string }[] = [];
  // First access page: the cover on most scans (a library title sheet on some).
  jobs.push({ url: iaPageUrl(ia.identifier, 0, o.width), dest: `${dir}/cover.jpg` });
  for (const r of ia.recipes ?? []) {
    const slug = slugify(r.title);
    r.leaves.forEach((leaf, i) => {
      jobs.push({
        url: page(leaf),
        dest: `${dir}/pages/${slug}/${pad(i + 1)}-leaf${leaf}.jpg`,
      });
    });
  }
  for (const sec of ia.sections ?? []) {
    sec.leaves.forEach((leaf, i) => {
      jobs.push({ url: page(leaf), dest: `${dir}/${sec.kind}/${sec.label}/${pad(i + 1)}-leaf${leaf}.jpg` });
    });
  }
  // Bulk runs are only downloaded with --bulk, but always listed as expected
  // output, so a run without --bulk keeps current ones and prunes stale ones.
  const bulk: { url: string; dest: string }[] = [];
  for (const range of ia.bulk ?? []) {
    for (let leaf = range.from; leaf <= range.to; leaf++) {
      bulk.push({
        url: page(leaf),
        dest: `${dir}/bulk/${range.label}/${pad(leaf - range.from + 1, 3)}-leaf${leaf}.jpg`,
      });
    }
  }
  if (o.bulk) jobs.push(...bulk);
  let fetched = 0;
  await pool(jobs, 4, async (j) => {
    const key = j.dest.slice(dir.length + 1);
    if ((await download(j.url, j.dest, o.force, { entries: ledger, key })) === 'fetched') fetched++;
  });
  console.log(`  scans: ${jobs.length} pages (${fetched} downloaded) from archive.org/details/${ia.identifier}`);
  return [...jobs, ...bulk].map((j) => j.dest.slice(dir.length + 1));
}

// ── Transcriptions ──────────────────────────────────────────────────────

/**
 * Project Gutenberg's license governs the "Project Gutenberg" trademark, not
 * the public-domain text; PG's own terms say that removing the header and
 * footer (every reference to the trademark) leaves an unrestricted text.
 * So keep only what's between the START and END markers — and fail rather
 * than write a file if they're missing, so license text never ships.
 */
export function stripGutenberg(raw: string, url: string): string {
  const start = raw.match(/^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/im);
  const end = raw.match(/^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK/im);
  if (!start || start.index === undefined || !end || end.index === undefined || end.index < start.index) {
    throw new Error(`${url}: no Project Gutenberg START/END markers — refusing to write unstripped text`);
  }
  const body = raw.slice(start.index + start[0].length, end.index).trim();
  if (/project gutenberg/i.test(body.slice(0, 2000)) || /project gutenberg/i.test(body.slice(-2000))) {
    console.warn(`  ! ${url}: "Project Gutenberg" still appears near the start/end of the stripped text — check it`);
  }
  return body + '\n';
}

async function fetchText(book: Book, dir: string, o: Opts, ledger: Ledger): Promise<string[]> {
  const rels: string[] = [];
  for (const t of book.text ?? []) {
    const rel = `text/${t.name}`;
    rels.push(rel);
    const dest = `${dir}/${rel}`;
    if (!o.force && ledger[rel] === t.url && (await exists(dest))) {
      // A cache hit must already be stripped — files from before stripping
      // existed still carry the license text, so strip those in place.
      const cached = await Deno.readTextFile(dest);
      if (/START OF (THE|THIS) PROJECT GUTENBERG EBOOK/i.test(cached)) {
        await Deno.writeTextFile(dest, stripGutenberg(cached, t.url));
        console.log(`  text: stripped cached ${t.url}`);
      } else console.log(`  text: cached ${t.url}`);
      continue;
    }
    // The raw download is a scratch file: it carries the PG license text.
    const raw = `${dest}.gutenberg-raw`;
    await download(t.url, raw, true);
    try {
      await Deno.writeTextFile(dest, stripGutenberg(await Deno.readTextFile(raw), t.url));
      ledger[rel] = t.url;
    } finally {
      await Deno.remove(raw);
    }
    console.log(`  text: downloaded + stripped ${t.url}`);
  }
  return rels;
}

/** Everything on disk for a book, grouped by folder — rebuilt each run so a
 *  partial run (--text only) doesn't drop what an earlier run fetched. */
async function indexDir(dir: string): Promise<Record<string, string[]>> {
  const index: Record<string, string[]> = {};
  async function walk(rel: string) {
    for await (const e of Deno.readDir(rel ? `${dir}/${rel}` : dir)) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(path);
      else if (path !== 'source.json' && path !== LEDGER && !path.endsWith('.part')) (index[rel || '.'] ??= []).push(path);
    }
  }
  await walk('');
  for (const k of Object.keys(index)) index[k].sort();
  return Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
}

/** Delete files under `dir` not in `keep`, then any directories left empty. */
async function prune(dir: string, keep: Set<string>): Promise<number> {
  let removed = 0;
  async function walk(rel: string): Promise<boolean> {
    let empty = true;
    for await (const e of Deno.readDir(rel ? `${dir}/${rel}` : dir)) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (await walk(path)) await Deno.remove(`${dir}/${path}`);
        else empty = false;
      } else if (keep.has(path)) {
        empty = false;
      } else {
        await Deno.remove(`${dir}/${path}`);
        removed++;
      }
    }
    return empty;
  }
  await walk('');
  return removed;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const o = parseArgs(Deno.args);
  const books = BOOKS.filter((b) => !o.only || o.only.has(b.id));
  // Only a full run knows the whole expected output, so only it prunes.
  const full = !o.only && o.text && o.images;
  const failures: string[] = [];
  if (full && (await exists(OUT))) {
    for await (const e of Deno.readDir(OUT)) {
      if (e.isDirectory && !BOOKS.some((b) => b.id === e.name)) {
        await Deno.remove(`${OUT}${e.name}`, { recursive: true });
        console.log(`removed out/${e.name}/ — no longer in the manifest`);
      }
    }
  }
  for (const book of books) {
    console.log(`${book.id} — ${book.title} (${book.author}, ${book.year})`);
    const dir = `${OUT}${book.id}`;
    await Deno.mkdir(dir, { recursive: true });
    // Each step fails independently: one flaky host shouldn't cost the rest.
    const steps: [boolean, typeof fetchText][] = [
      [o.text, fetchText],
      [o.images, fetchScans],
    ];
    const expected = new Set(['source.json', LEDGER]);
    const ledger = await readLedger(dir);
    let complete = full;
    for (const [enabled, step] of steps) {
      if (!enabled) continue;
      try {
        for (const rel of await step(book, dir, o, ledger)) expected.add(rel);
      } catch (e) {
        complete = false; // don't prune on a partial picture of what's expected
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  ✗ ${step.name}: ${msg}`);
        failures.push(`${book.id}/${step.name}: ${msg}`);
      }
    }
    if (complete) {
      const n = await prune(dir, expected);
      if (n) console.log(`  pruned ${n} file(s) no longer in the manifest`);
      for (const k of Object.keys(ledger)) if (!expected.has(k)) delete ledger[k];
    }
    await Deno.writeTextFile(`${dir}/${LEDGER}`, JSON.stringify(ledger, null, 2) + '\n');
    const { text: _t, ia, ...meta } = book;
    await Deno.writeTextFile(
      `${dir}/source.json`,
      JSON.stringify(
        {
          ...meta,
          scan: ia ? `https://archive.org/details/${ia.identifier}` : undefined,
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
