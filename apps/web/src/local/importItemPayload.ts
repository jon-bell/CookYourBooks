import type { Database } from '@cookyourbooks/db';

type ImportItemInsert = Database['public']['Tables']['import_items']['Insert'];

/**
 * Parse a local SQLite JSON-text column that stores a `string[]` (e.g.
 * `extra_storage_paths`, held as `'[]'` / `'["a","b"]'` / null) into a real
 * array. Defensive by design: a non-string, empty string, non-array, or
 * malformed JSON all yield `[]` rather than throwing. Mirrors the
 * `created_recipe_ids` parse in `sync.ts`.
 */
export function parseJsonStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Build the Supabase `import_items` INSERT/upsert payload from a local
 * SQLite row.
 *
 * IMPORTANT: this is a hand-maintained mirror of the `import_items` Insert
 * type. Any NEW client-authored column must be added here, or it is silently
 * dropped on push and takes the server DEFAULT on insert. `extra_storage_paths`
 * was exactly such a bug: a multi-page recipe's continuation pages are folded
 * into the leader's `extra_storage_paths` locally, but the column was missing
 * from this payload, so the server row defaulted to `'{}'` and the OCR worker
 * only ever saw the first page. Only columns the client authors at insert time
 * belong here; server-owned columns (`needs_fallback`, token/cost counters,
 * `claim_*`, timestamps) are intentionally omitted so the server owner/default
 * wins.
 */
export function buildImportItemInsertPayload(local: Record<string, unknown>): ImportItemInsert {
  return {
    id: local.id as string,
    batch_id: local.batch_id as string,
    owner_id: local.owner_id as string,
    page_index: local.page_index as number,
    storage_path: local.storage_path as string,
    thumb_path: (local.thumb_path as string | null) ?? null,
    source_pdf_path: (local.source_pdf_path as string | null) ?? null,
    source_pdf_page: (local.source_pdf_page as number | null) ?? null,
    assigned_collection_id: (local.assigned_collection_id as string | null) ?? null,
    assigned_page_number: (local.assigned_page_number as number | null) ?? null,
    assigned_recipe_id: (local.assigned_recipe_id as string | null) ?? null,
    is_toc: local.is_toc === 1 || local.is_toc === true,
    kind: (local.kind as string | null) ?? 'RECIPE',
    status: local.status as ImportItemInsert['status'],
    extra_storage_paths: parseJsonStringArray(local.extra_storage_paths),
  };
}
