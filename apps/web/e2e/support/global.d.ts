// Ambient declaration mirroring the window hook set in `apps/web/src/supabase.ts`.
// The test suite doesn't import the app's supabase module (it runs under
// node, not the browser), so we restate the global here with a minimal
// signature the specs actually exercise.
export {};

/** Minimal duck-typed shape used by the bakeoff shim — keeping a copy of
 * the full `BakeoffVariant`/result types here would be churn for tests. */
interface BakeoffShimVariant {
  id: string;
  name: string;
  provider: 'gemini' | 'openai-compatible';
  model: string;
  prompt: string;
}

declare global {
  interface Window {
    __cybBakeoffShim?: (
      variant: BakeoffShimVariant,
      source: Blob | File,
    ) => Promise<{
      drafts: unknown[];
      rawText: string;
      usage: { promptTokens: number; completionTokens: number };
      elapsedMs?: number;
    }>;
    __cybSupabase?: {
      rpc(
        fn: string,
        args: Record<string, unknown>,
      ): Promise<{ data?: unknown; error?: { message?: string } | null }>;
      from(table: string): {
        select(cols: string): {
          eq(
            col: string,
            val: string,
          ): {
            maybeSingle(): Promise<{ data?: { id?: string } | null }>;
          };
        };
        update(row: Record<string, unknown>): {
          eq(col: string, val: string): Promise<{ error?: { message?: string } | null }>;
        };
      };
    };
  }
}
