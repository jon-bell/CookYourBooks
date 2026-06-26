import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from './database.types.js';

/**
 * Typed Supabase client used by the public-collection (Discover / fork)
 * helpers in fork.ts. The legacy Supabase{Recipe,RecipeCollection}Repository
 * adapters + fetchRecipesForCollections that used to live here were removed:
 * the local-first sync engine (apps/web/src/local/sync.ts) talks to PostgREST
 * directly and the UI reads from the cr-sqlite cache, so nothing consumed them.
 */
export type CookbooksClient = SupabaseClient<Database>;
