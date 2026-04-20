import type { CliConfig } from './config.js';

// --- Domain shapes (match the JSON that cli_export_library / cli_import_recipe produce) ---

export interface ExportedIngredient {
  id?: string;
  sort_order?: number;
  type?: string;
  name: string;
  preparation?: string | null;
  notes?: string | null;
  quantity_type?: string | null;
  quantity_amount?: number | null;
  quantity_whole?: number | null;
  quantity_numerator?: number | null;
  quantity_denominator?: number | null;
  quantity_min?: number | null;
  quantity_max?: number | null;
  quantity_unit?: string | null;
}

export interface ExportedInstruction {
  id?: string;
  step_number: number;
  text: string;
  ingredient_refs?: string[];
}

export interface ExportedRecipe {
  id?: string;
  title: string;
  servings_amount?: number | null;
  servings_description?: string | null;
  sort_order?: number;
  ingredients: ExportedIngredient[];
  instructions: ExportedInstruction[];
}

export interface ExportedCollection {
  id: string;
  title: string;
  source_type: 'PERSONAL' | 'PUBLISHED_BOOK' | 'WEBSITE';
  is_public: boolean;
  author: string | null;
  isbn: string | null;
  publisher: string | null;
  publication_year: number | null;
  description: string | null;
  notes: string | null;
  source_url: string | null;
  date_accessed: string | null;
  site_name: string | null;
  recipes: ExportedRecipe[];
}

export interface LibraryExport {
  exported_at: string;
  owner_id: string;
  collections: ExportedCollection[];
}

// --- Low-level RPC client ---

async function rpc<T>(config: CliConfig, fn: string, args: Record<string, unknown>): Promise<T> {
  const url = `${config.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${fn}: HTTP ${resp.status} ${body}`);
  }
  // PostgREST RPC returns the function's result directly (or null).
  return (await resp.json()) as T;
}

export async function exportLibrary(config: CliConfig): Promise<LibraryExport> {
  return rpc<LibraryExport>(config, 'cli_export_library', { raw_token: config.token });
}

export async function importRecipe(
  config: CliConfig,
  recipe: ExportedRecipe,
  targetCollectionId?: string,
): Promise<string> {
  const newId = await rpc<string>(config, 'cli_import_recipe', {
    raw_token: config.token,
    target_collection_id: targetCollectionId ?? null,
    recipe,
  });
  return newId;
}
