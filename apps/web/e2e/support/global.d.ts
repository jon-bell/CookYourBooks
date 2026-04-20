// Ambient declaration mirroring the window hook set in `apps/web/src/supabase.ts`.
// The test suite doesn't import the app's supabase module (it runs under
// node, not the browser), so we restate the global here with a minimal
// signature the specs actually exercise.
export {};

declare global {
  interface Window {
    __cybSupabase?: {
      rpc(
        fn: string,
        args: Record<string, unknown>,
      ): Promise<{ error?: { message?: string } | null }>;
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
