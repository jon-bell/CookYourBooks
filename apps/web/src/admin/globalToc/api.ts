import { supabase } from '../../supabase.js';
import { lookupOpenLibrary, normalizeIsbn } from './openLibrary.js';

// Thin wrapper over the global_cookbooks / global_toc_entries tables.
// Reads are public; writes are admin-only at the RLS layer, so non-admin
// callers will get a 401 from PostgREST on mutating calls.

export interface GlobalCookbook {
  id: string;
  isbn: string | null;
  title: string;
  author: string | null;
  publisher: string | null;
  publication_year: number | null;
  cover_image_path: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface GlobalTocEntry {
  id: string;
  cookbook_id: string;
  title: string;
  page_number: number | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type GlobalCookbookDraft = {
  isbn?: string | null;
  title: string;
  author?: string | null;
  publisher?: string | null;
  publication_year?: number | null;
  cover_image_path?: string | null;
  notes?: string | null;
};

// ---------- Cookbooks ----------

export async function listCookbooks(search?: string): Promise<GlobalCookbook[]> {
  let q = supabase
    .from('global_cookbooks')
    .select('*')
    .order('title', { ascending: true })
    .limit(500);
  const trimmed = search?.trim();
  if (trimmed) {
    // Match against title, author, or ISBN. ILIKE so it's case-insensitive.
    const like = `%${trimmed.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    q = q.or(`title.ilike.${like},author.ilike.${like},isbn.ilike.${like}`);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as GlobalCookbook[];
}

export async function getCookbook(id: string): Promise<GlobalCookbook | null> {
  const { data, error } = await supabase
    .from('global_cookbooks')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as GlobalCookbook) ?? null;
}

export async function createCookbook(draft: GlobalCookbookDraft): Promise<GlobalCookbook> {
  const payload = normalizeDraft(draft);
  const { data, error } = await supabase
    .from('global_cookbooks')
    .insert(payload)
    .select('*')
    .single();
  if (error) throw error;
  return data as GlobalCookbook;
}

export async function updateCookbook(
  id: string,
  draft: GlobalCookbookDraft,
): Promise<GlobalCookbook> {
  const payload = normalizeDraft(draft);
  const { data, error } = await supabase
    .from('global_cookbooks')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as GlobalCookbook;
}

export async function deleteCookbook(id: string): Promise<void> {
  // ToC entries cascade via the FK.
  const { error } = await supabase.from('global_cookbooks').delete().eq('id', id);
  if (error) throw error;
}

function normalizeDraft(draft: GlobalCookbookDraft): GlobalCookbookDraft {
  const cleanedIsbn = draft.isbn ? normalizeIsbn(draft.isbn) : null;
  return {
    ...draft,
    title: draft.title.trim(),
    isbn: cleanedIsbn,
    author: emptyToNull(draft.author),
    publisher: emptyToNull(draft.publisher),
    notes: emptyToNull(draft.notes),
    publication_year: draft.publication_year ?? null,
    cover_image_path: emptyToNull(draft.cover_image_path),
  };
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

// ---------- ToC entries ----------

export async function listTocEntries(cookbookId: string): Promise<GlobalTocEntry[]> {
  const { data, error } = await supabase
    .from('global_toc_entries')
    .select('*')
    .eq('cookbook_id', cookbookId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as GlobalTocEntry[];
}

export interface TocEntryDraft {
  title: string;
  page_number?: number | null;
}

// Bulk replace: simpler than diffing for an admin tool. Delete-all then
// insert with fresh sort_orders. The cascade on delete-cookbook still
// catches them if the parent is deleted later.
export async function replaceTocEntries(
  cookbookId: string,
  drafts: TocEntryDraft[],
): Promise<GlobalTocEntry[]> {
  const cleaned = drafts
    .map((d, i) => ({
      title: d.title.trim(),
      page_number: d.page_number ?? null,
      sort_order: i,
    }))
    .filter((d) => d.title !== '');

  const { error: delErr } = await supabase
    .from('global_toc_entries')
    .delete()
    .eq('cookbook_id', cookbookId);
  if (delErr) throw delErr;

  if (cleaned.length === 0) return [];

  const { data, error } = await supabase
    .from('global_toc_entries')
    .insert(cleaned.map((d) => ({ ...d, cookbook_id: cookbookId })))
    .select('*');
  if (error) throw error;
  return (data ?? []) as GlobalTocEntry[];
}

// ---------- Open Library + cover upload ----------

export interface OpenLibraryResult {
  metadata: {
    title?: string;
    author?: string;
    publisher?: string;
    publicationYear?: number;
  } | null;
  coverImagePath: string | null;
}

// Looks up the ISBN, downloads the cover, uploads it to the `covers`
// bucket under `global/<cookbookId>.jpg`, and returns the storage path
// along with the parsed metadata. Callers merge the metadata into their
// in-progress draft (no DB writes happen here — admin still has to hit
// save).
export async function fetchFromOpenLibrary(
  isbn: string,
  cookbookId: string,
): Promise<OpenLibraryResult> {
  const lookup = await lookupOpenLibrary(isbn);
  let coverPath: string | null = null;

  if (lookup.cover) {
    const path = `global/${cookbookId}.jpg`;
    const { error } = await supabase.storage
      .from('covers')
      .upload(path, lookup.cover, {
        contentType: 'image/jpeg',
        upsert: true,
      });
    if (error) throw error;
    coverPath = path;
  }

  return {
    metadata: lookup.metadata,
    coverImagePath: coverPath,
  };
}
