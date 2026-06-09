// deno run --allow-env --allow-read --allow-net scripts/optimize-covers.ts [--dry-run]
//
// One-time (idempotent) backfill that re-encodes every existing object in the
// public `covers` bucket: downscale to COVER_MAX_EDGE + re-encode JPEG, and
// stamp the immutable 1-year cache header. Covers uploaded before the
// write-time optimization landed were stored raw (multi-MB phone photos /
// Gemini PNGs) with a 1-hour cache.
//
// Overwrites IN PLACE (same path) — no DB write, no sync churn, no orphans.
// Safe to overwrite even though the URL is unchanged: any client holding the
// old bytes cached them under the previous max-age=3600, so it refreshes
// within the hour; everyone else gets the optimized bytes + 1-year cache on
// next fetch.
//
// Reads SUPABASE_URL + service-role key from apps/web/.env.local.prod
// (same pattern as load-usda-foods.ts / embed-nutrition-foods.ts).
// Idempotent: objects already carrying the immutable cache header are skipped.
//
//   --dry-run     report before/after sizes without uploading
//   --env-file    override credentials file path
//   --min-bytes   skip objects smaller than this (default 4096)
//   --thumbs-only skip the full-size re-encode phase; only mint missing
//                 .thumb.jpg siblings (leaves existing covers untouched)

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';
import {
  COVER_CACHE_CONTROL,
  reencodeCover,
  reencodeThumb,
  thumbPathFor,
} from '../supabase/functions/import-worker/coverEncode.ts';

const BUCKET = 'covers';

async function loadEnv(envFileOverride?: string): Promise<Record<string, string>> {
  const candidates = envFileOverride
    ? [new URL('file://' + envFileOverride)]
    : [
        new URL('../apps/web/.env.local.prod', import.meta.url),
        new URL('../supabase/.env.prod', import.meta.url),
        new URL('../apps/web/.env.local', import.meta.url),
      ];
  for (const p of candidates) {
    try {
      const text = await Deno.readTextFile(p);
      console.error(`(env from ${p.pathname})`);
      const env: Record<string, string> = {};
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
      }
      return env;
    } catch { /* try next */ }
  }
  throw new Error(`No env file found. Tried: ${candidates.map((c) => c.pathname).join(', ')}`);
}

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
function flag(name: string): boolean {
  return Deno.args.includes(`--${name}`);
}

interface ListedFile {
  path: string;
  size: number;
  mimetype: string;
  cacheControl: string;
}

// Storage `list` is one directory deep, so recurse: a folder entry has a null
// `id`; a file entry carries a `metadata` object.
async function* listFiles(sb: SupabaseClient, prefix: string): AsyncGenerator<ListedFile> {
  const pageSize = 100;
  let offset = 0;
  while (true) {
    const { data, error } = await sb.storage
      .from(BUCKET)
      .list(prefix, { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      const full = prefix ? `${prefix}/${row.name}` : row.name;
      // deno-lint-ignore no-explicit-any
      const meta = (row as any).metadata as
        | { size?: number; mimetype?: string; cacheControl?: string }
        | null;
      if (row.id === null || meta == null) {
        yield* listFiles(sb, full); // folder
      } else {
        yield {
          path: full,
          size: meta.size ?? 0,
          mimetype: meta.mimetype ?? 'image/jpeg',
          cacheControl: meta.cacheControl ?? '',
        };
      }
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
}

async function main() {
  const dryRun = flag('dry-run');
  const minBytes = Number(arg('min-bytes') ?? '4096');
  const env = await loadEnv(arg('env-file'));
  const url = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
  const key =
    env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY ?? env.SERVICE_ROLE_KEY ?? '';
  if (!url || !key) throw new Error('Missing SUPABASE_URL or service-role key in env file');
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // --- Phase 1: collect all bucket paths so we know which thumbs exist ---
  console.error('listing bucket…');
  const allFiles: ListedFile[] = [];
  for await (const file of listFiles(sb, '')) {
    allFiles.push(file);
  }
  const existingPaths = new Set(allFiles.map((f) => f.path));
  console.error(`found ${allFiles.length} objects`);

  // --- Phase 2: re-encode full-size covers that still carry old cache headers ---
  const thumbsOnly = flag('thumbs-only');
  let seen = 0;
  let optimized = 0;
  let headerOnly = 0;
  let skipped = 0;
  let savedBytes = 0;

  for (const file of thumbsOnly ? [] : allFiles) {
    // Skip thumb-sibling objects — they are handled in phase 3.
    if (file.path.endsWith('.thumb.jpg')) continue;

    seen += 1;
    // Already migrated (carries the immutable header) -> idempotent skip.
    if (file.cacheControl.includes('immutable')) {
      skipped += 1;
      continue;
    }
    if (file.size > 0 && file.size < minBytes) {
      skipped += 1;
      continue;
    }

    const { data: blob, error: dlErr } = await sb.storage.from(BUCKET).download(file.path);
    if (dlErr || !blob) {
      console.error(`! download failed ${file.path}: ${dlErr?.message}`);
      continue;
    }
    const original = new Uint8Array(await blob.arrayBuffer());
    const enc = await reencodeCover(original, file.mimetype);
    const shrank = enc.bytes.length < original.length;

    if (dryRun) {
      console.error(
        `${shrank ? 'reencode' : 'header  '} ${file.path}  ${original.length} -> ${enc.bytes.length} (${file.mimetype} -> ${enc.contentType})`,
      );
      if (shrank) {
        optimized += 1;
        savedBytes += original.length - enc.bytes.length;
      } else headerOnly += 1;
      continue;
    }

    const { error: upErr } = await sb.storage
      .from(BUCKET)
      .upload(file.path, new Blob([enc.bytes], { type: enc.contentType }), {
        upsert: true,
        contentType: enc.contentType,
        cacheControl: COVER_CACHE_CONTROL,
      });
    if (upErr) {
      console.error(`! upload failed ${file.path}: ${upErr.message}`);
      continue;
    }
    if (shrank) {
      optimized += 1;
      savedBytes += original.length - enc.bytes.length;
    } else {
      headerOnly += 1;
    }
    console.error(`ok ${file.path}  ${original.length} -> ${enc.bytes.length}`);
  }

  console.error(
    `\n${dryRun ? '[dry-run] ' : ''}done: ${seen} seen, ${optimized} re-encoded, ` +
      `${headerOnly} header-only, ${skipped} skipped, ${(savedBytes / 1024 / 1024).toFixed(1)} MB saved`,
  );

  // --- Phase 3: mint missing .thumb.jpg siblings (idempotent) ---
  let thumbSeen = 0;
  let thumbMinted = 0;
  let thumbSkipped = 0;

  for (const file of allFiles) {
    // Only process original covers (not existing thumbs).
    if (file.path.endsWith('.thumb.jpg')) continue;
    // Skip very small objects (unlikely real covers).
    if (file.size > 0 && file.size < minBytes) continue;

    thumbSeen += 1;
    const thumbPath = thumbPathFor(file.path);

    // Thumb already exists — skip (idempotent).
    if (existingPaths.has(thumbPath)) {
      thumbSkipped += 1;
      continue;
    }

    if (dryRun) {
      console.error(`thumb-missing ${file.path} -> ${thumbPath}`);
      thumbMinted += 1;
      continue;
    }

    const { data: blob, error: dlErr } = await sb.storage.from(BUCKET).download(file.path);
    if (dlErr || !blob) {
      console.error(`! thumb download failed ${file.path}: ${dlErr?.message}`);
      continue;
    }
    const original = new Uint8Array(await blob.arrayBuffer());
    const thumb = await reencodeThumb(original, file.mimetype);

    const { error: upErr } = await sb.storage
      .from(BUCKET)
      .upload(thumbPath, new Blob([thumb.bytes], { type: thumb.contentType }), {
        upsert: true,
        contentType: thumb.contentType,
        cacheControl: COVER_CACHE_CONTROL,
      });
    if (upErr) {
      console.error(`! thumb upload failed ${thumbPath}: ${upErr.message}`);
      continue;
    }
    thumbMinted += 1;
    console.error(`thumb ok ${thumbPath}  ${thumb.bytes.length} bytes`);
  }

  console.error(
    `\n${dryRun ? '[dry-run] ' : ''}thumbs: ${thumbSeen} covers checked, ` +
      `${thumbMinted} minted, ${thumbSkipped} already present`,
  );
}

await main();
