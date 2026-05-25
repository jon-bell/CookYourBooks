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
  // ToC entries cascade via the FK. Storage doesn't cascade, so we
  // best-effort sweep any leftover covers we uploaded for this cookbook.
  await deleteCoversFor(id);
  const { error } = await supabase.from('global_cookbooks').delete().eq('id', id);
  if (error) throw error;
}

async function sweepOldCovers(cookbookId: string, keepPath: string): Promise<void> {
  const { data } = await supabase.storage.from('covers').list('global', {
    limit: 1000,
    search: cookbookId,
  });
  const stale = (data ?? [])
    .map((f) => `global/${f.name}`)
    .filter((p) => p !== keepPath && p.startsWith(`global/${cookbookId}-`));
  if (stale.length > 0) {
    await supabase.storage.from('covers').remove(stale);
  }
}

async function deleteCoversFor(cookbookId: string): Promise<void> {
  const { data } = await supabase.storage.from('covers').list('global', {
    limit: 1000,
    search: cookbookId,
  });
  const paths = (data ?? [])
    .map((f) => `global/${f.name}`)
    .filter((p) => p.startsWith(`global/${cookbookId}-`) || p === `global/${cookbookId}.jpg`);
  if (paths.length > 0) {
    // Failure here shouldn't block the row delete — orphan storage is
    // recoverable (rerun delete), an orphan row is not.
    await supabase.storage.from('covers').remove(paths);
  }
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

// ---------- Admin import from user library ----------

export interface ImportCandidate {
  collection_id: string;
  title: string;
  author: string | null;
  raw_isbn: string | null;
  isbn: string | null;
  publisher: string | null;
  publication_year: number | null;
  cover_image_path: string | null;
  owner_id: string;
  owner_name: string | null;
  recipe_count: number;
  created_at: string;
}

// Lists user cookbooks with an ISBN that aren't yet mirrored into the
// global catalog. Backed by the `admin_global_toc_import_candidates`
// view, which filters by RLS — non-admins simply get an empty list.
export async function listImportCandidates(): Promise<ImportCandidate[]> {
  const { data, error } = await supabase
    .from('admin_global_toc_import_candidates')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as ImportCandidate[];
}

// Calls the admin-only RPC that copies a user cookbook into the global
// catalog. Returns the new global_cookbooks.id.
export async function adminImportCollection(sourceCollectionId: string): Promise<string> {
  const { data, error } = await supabase.rpc('global_toc_admin_import', {
    source_collection_id: sourceCollectionId,
  });
  if (error) throw error;
  return data as string;
}

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
// bucket under `global/<cookbookId>-<ts>.jpg`, and returns the storage
// path along with the parsed metadata. Callers merge the metadata into
// their in-progress draft (no DB writes happen here — admin still has
// to hit save). The timestamp in the path is a cheap cache-buster: the
// public storage URL is content-addressable, so a refetch always
// renders without admins having to hard-reload. Old objects linger
// until the cookbook is deleted.
export async function fetchFromOpenLibrary(
  isbn: string,
  cookbookId: string,
): Promise<OpenLibraryResult> {
  const lookup = await lookupOpenLibrary(isbn);
  let coverPath: string | null = null;

  if (lookup.cover) {
    const path = `global/${cookbookId}-${Date.now()}.jpg`;
    const { error } = await supabase.storage
      .from('covers')
      .upload(path, lookup.cover, {
        contentType: 'image/jpeg',
        upsert: false,
      });
    if (error) throw error;
    coverPath = path;
    // Sweep older uploads for this cookbook so re-fetches don't pile
    // up storage. Best-effort: failure leaves a tiny orphan, not a bug.
    await sweepOldCovers(cookbookId, path);
  }

  return {
    metadata: lookup.metadata,
    coverImagePath: coverPath,
  };
}
