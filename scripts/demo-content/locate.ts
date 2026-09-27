// deno run --allow-net scripts/demo-content/locate.ts <ia-identifier> <query> [query…]
//
// Finds recipes inside an Internet Archive scan so they can be added to
// ./sources.ts. Uses IA's search-inside (the OCR text layer) and prints, per
// hit, the leaf number sources.ts wants plus the printed page number when
// the scan has a page map. Quote multi-word queries for a phrase match:
//
//   deno run --allow-net scripts/demo-content/locate.ts italiancookbooka00gentiala '"risotto milanaise"' polenta
//
// Search-inside is also where the index/TOC hits show up — pick the leaf
// whose text is the recipe heading, not the "Risotto Milanaise, 22" line.

const [identifier, ...queries] = Deno.args;
if (!identifier || !queries.length) {
  console.error('usage: locate.ts <ia-identifier> <query> [query…]');
  Deno.exit(2);
}

const meta = await (await fetch(`https://archive.org/metadata/${identifier}`)).json();
if (!meta.server) {
  console.error(`no such IA item: ${identifier}`);
  Deno.exit(1);
}
const { server, dir, files } = meta as { server: string; dir: string; files: { name: string }[] };

const printed = new Map<number, string>();
// Looked up by suffix: user uploads name it after the original file.
const pnFile = files.find((f) => f.name.endsWith('_page_numbers.json'));
const pn = pnFile ? await fetch(`https://${server}${dir}/${encodeURIComponent(pnFile.name)}`) : null;
if (pn?.ok) {
  const { pages } = (await pn.json()) as { pages: { leafNum: number; pageNumber: string }[] };
  for (const p of pages) if (p.pageNumber) printed.set(p.leafNum, p.pageNumber);
} else {
  await pn?.body?.cancel();
  console.log('(no page map for this scan — leaf numbers only)');
}

for (const q of queries) {
  const url =
    `https://${server}/fulltext/inside.php?` +
    new URLSearchParams({ item_id: identifier, doc: identifier, path: dir, q });
  const res = await fetch(url);
  console.log(`== ${q}`);
  if (!res.ok) {
    await res.body?.cancel();
    console.log(`   search-inside HTTP ${res.status}`);
    continue;
  }
  const { matches = [] } = (await res.json()) as {
    matches?: { text: string; par: { page: number }[] }[];
  };
  if (!matches.length) console.log('   (no hits)');
  for (const m of matches.slice(0, 8)) {
    const leaf = m.par[0].page;
    const text = m.text.replace(/<\/?IA_FTS_MATCH>/g, '').replace(/\s+/g, ' ').slice(0, 80);
    const page = printed.get(leaf);
    console.log(`   leaf ${String(leaf).padStart(4)}${page ? ` (p. ${page})` : ''}  ${text}`);
  }
}
