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
