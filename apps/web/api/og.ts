// Serverless function that renders Open Graph HTML for specific
// public URLs. Invoked via the UA-gated rewrite in `vercel.json`, so
// only link-unfurling bots (Twitterbot, Slackbot, facebookexternalhit,
// Discordbot, …) hit this path. Regular browsers get the SPA.
//
// Supabase access: anon key only. Public collections are visible via
// the `public_collections` view (security invoker, is_public filter).
// Private data never reaches this function, so a fallback card is
// emitted when the collection isn't public instead of leaking a 404.

import { cleanDescription, renderOgHtml, type OgMeta } from './_og-html.js';

export const config = { runtime: 'edge' };

const SITE_ORIGIN = 'https://cookyourbooks.app';

function env(name: string): string | undefined {
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name];
  return v && v.length > 0 ? v : undefined;
}

function supabaseCreds(): { url: string; anonKey: string } | undefined {
  const url = env('SUPABASE_URL') ?? env('VITE_SUPABASE_URL');
  const anonKey =
    env('SUPABASE_ANON_KEY') ??
    env('SUPABASE_PUBLISHABLE_KEY') ??
    env('VITE_SUPABASE_ANON_KEY');
  if (!url || !anonKey) return undefined;
  return { url, anonKey };
}

async function supabaseGet<T>(
  path: string,
  creds: { url: string; anonKey: string },
): Promise<T[] | undefined> {
  const resp = await fetch(`${creds.url.replace(/\/$/, '')}/rest/v1${path}`, {
    headers: {
      apikey: creds.anonKey,
      Authorization: `Bearer ${creds.anonKey}`,
      Accept: 'application/json',
    },
    // Crawler traffic is rare; skip the edge cache so an edit-then-
    // reshare workflow sees fresh titles.
    cache: 'no-store',
  });
  if (!resp.ok) return undefined;
  return (await resp.json()) as T[];
}

interface PublicCollectionRow {
  id: string;
  title: string;
  description: string | null;
  notes: string | null;
  source_type: string;
  author: string | null;
}

interface RecipeRow {
  id: string;
  title: string;
  notes: string | null;
  collection_id: string;
}

async function fetchCollection(
  id: string,
  creds: { url: string; anonKey: string },
): Promise<PublicCollectionRow | undefined> {
  const rows = await supabaseGet<PublicCollectionRow>(
    `/public_collections?id=eq.${encodeURIComponent(
      id,
    )}&select=id,title,description,notes,source_type,author&limit=1`,
    creds,
  );
  return rows?.[0];
}

async function fetchRecipe(
  collectionId: string,
  recipeId: string,
  creds: { url: string; anonKey: string },
): Promise<RecipeRow | undefined> {
  const rows = await supabaseGet<RecipeRow>(
    `/recipes?id=eq.${encodeURIComponent(recipeId)}&collection_id=eq.${encodeURIComponent(
      collectionId,
    )}&select=id,title,notes,collection_id&limit=1`,
    creds,
  );
  return rows?.[0];
}

function fallbackMeta(url: string): OgMeta {
  return {
    kind: 'site',
    title: 'CookYourBooks',
    description:
      'Your cookbook library, with you everywhere. Offline-first recipe manager.',
    url,
    subtitle: 'Free as in sourdough starter',
  };
}

function collectionMeta(
  url: string,
  row: PublicCollectionRow,
): OgMeta {
  const subtitleBits: string[] = [];
  if (row.author) subtitleBits.push(`by ${row.author}`);
  if (row.source_type === 'PUBLISHED_BOOK') subtitleBits.push('Cookbook');
  else if (row.source_type === 'WEBSITE') subtitleBits.push('Web collection');
  return {
    kind: 'collection',
    title: row.title,
    description:
      cleanDescription(row.description) ||
      cleanDescription(row.notes) ||
      `A public collection on CookYourBooks.`,
    url,
    subtitle: subtitleBits.join(' · '),
  };
}

function recipeMeta(
  url: string,
  recipe: RecipeRow,
  collection: PublicCollectionRow,
): OgMeta {
  return {
    kind: 'recipe',
    title: recipe.title,
    description:
      cleanDescription(recipe.notes) ||
      `A recipe from "${collection.title}" on CookYourBooks.`,
    url,
    subtitle: collection.title,
  };
}

export default async function handler(req: Request): Promise<Response> {
  const incoming = new URL(req.url);
  const kind = incoming.searchParams.get('kind');
  const cid = incoming.searchParams.get('cid');
  const rid = incoming.searchParams.get('rid');

  // Canonical URL we want bots to remember — never the /api/og rewrite
  // target, always the user-facing path.
  const canonicalPath =
    kind === 'recipe' && cid && rid
      ? `/collections/${cid}/recipes/${rid}`
      : kind === 'collection' && cid
        ? `/collections/${cid}`
        : '/';
  const canonicalUrl = `${SITE_ORIGIN}${canonicalPath}`;

  const creds = supabaseCreds();
  let meta: OgMeta = fallbackMeta(canonicalUrl);

  if (creds && kind === 'collection' && cid) {
    const col = await fetchCollection(cid, creds);
    if (col) meta = collectionMeta(canonicalUrl, col);
  } else if (creds && kind === 'recipe' && cid && rid) {
    const col = await fetchCollection(cid, creds);
    if (col) {
      const recipe = await fetchRecipe(cid, rid, creds);
      if (recipe) meta = recipeMeta(canonicalUrl, recipe, col);
    }
  }

  return new Response(renderOgHtml(meta), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short cache: unfurlers revisit occasionally; fresh edits should
      // propagate within minutes, not hours.
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  });
}
