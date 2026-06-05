import { supabase } from '../supabase.js';
import { normalizeIsbn } from '../admin/globalToc/openLibrary.js';

// Public-readable lookup for the global cookbook catalog. Mirrors the
// admin/globalToc/api.ts reads but lives under data/ so non-admin pages
// can pull it without importing from the admin module tree.

export interface GlobalCookbookSummary {
  id: string;
  isbn: string | null;
  title: string;
  author: string | null;
  publisher: string | null;
  publication_year: number | null;
  cover_image_path: string | null;
}

export interface GlobalCookbookWithEntries extends GlobalCookbookSummary {
  entries: { title: string; page_number: number | null; sort_order: number }[];
}

// Lists global_cookbooks for the Discover page. Public read (no auth
// required), so anonymous landing-page visitors see the catalog too.
export async function listGlobalCookbooks(search?: string): Promise<GlobalCookbookSummary[]> {
  let q = supabase
    .from('global_cookbooks')
    .select('id, isbn, title, author, publisher, publication_year, cover_image_path')
    .order('title', { ascending: true })
    .limit(50);
  const trimmed = search?.trim();
  if (trimmed) {
    const like = `%${trimmed.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    q = q.or(`title.ilike.${like},author.ilike.${like},isbn.ilike.${like}`);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as GlobalCookbookSummary[];
}

// Hits global_cookbooks by normalized ISBN. Returns null on no match.
// Does not error on bad input — callers can poll as the user types and
// just need a tristate (loading / found / not-found).
export async function findCookbookByIsbn(
  rawIsbn: string,
): Promise<GlobalCookbookWithEntries | null> {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return null;

  const { data: cb, error: cbErr } = await supabase
    .from('global_cookbooks')
    .select('id, isbn, title, author, publisher, publication_year, cover_image_path')
    .eq('isbn', isbn)
    .maybeSingle();
  if (cbErr) throw cbErr;
  if (!cb) return null;

  const { data: entries, error: entriesErr } = await supabase
    .from('global_toc_entries')
    .select('title, page_number, sort_order')
    .eq('cookbook_id', cb.id)
    .order('sort_order', { ascending: true });
  if (entriesErr) throw entriesErr;

  return {
    ...(cb as GlobalCookbookSummary),
    entries: (entries ?? []) as GlobalCookbookWithEntries['entries'],
  };
}

/**
 * Bulk-fetch ToC titles for a set of global_cookbook ids. Used by the
 * Discover page to expand multiple cards without N+1 round-trips. The
 * `global_toc_entries` table is public-readable so this works for
 * anonymous visitors too.
 */
export async function listGlobalTocEntries(
  cookbookIds: readonly string[],
): Promise<Map<string, { title: string; page_number: number | null }[]>> {
  const out = new Map<string, { title: string; page_number: number | null }[]>();
  if (cookbookIds.length === 0) return out;
  const { data, error } = await supabase
    .from('global_toc_entries')
    .select('cookbook_id, title, page_number, sort_order')
    .in('cookbook_id', cookbookIds as string[])
    .order('cookbook_id', { ascending: true })
    .order('sort_order', { ascending: true });
  if (error) throw error;
  for (const row of (data ?? []) as {
    cookbook_id: string;
    title: string;
    page_number: number | null;
  }[]) {
    const arr = out.get(row.cookbook_id) ?? [];
    arr.push({ title: row.title, page_number: row.page_number });
    out.set(row.cookbook_id, arr);
  }
  return out;
}
