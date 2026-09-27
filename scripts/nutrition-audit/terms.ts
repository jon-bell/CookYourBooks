// Re-export of the edge-function copy, which is itself generated from
// the domain source by scripts/sync-ingredient-terms.mjs.
//
// The harness deliberately does NOT keep its own copy: a third copy is a
// third thing to forget to update, and a replay that measures a stale
// extractor silently reports the wrong before/after.
export * from '../../supabase/functions/nutrition/_ingredientTerms.ts';
