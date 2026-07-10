// Pure (supabase-free) home for the saved-model display label, so unit tests
// and other data-free modules can import it without dragging in the supabase
// client (whose module init throws when VITE_SUPABASE_URL is unset — e.g.
// vitest in CI). api.ts re-exports it for existing importers.

/** "gemini · gemini-3.5-flash" / "openrouter · qwen3-vl" — the picker's
 *  option label. */
export function formatSavedModel(m: {
  provider: string;
  endpoint: string;
  model: string;
  label?: string | null;
}): string {
  if (m.label && m.label.trim() !== '') return m.label;
  const where = m.provider === 'gemini' ? 'gemini' : m.endpoint;
  return `${where} · ${m.model}`;
}
