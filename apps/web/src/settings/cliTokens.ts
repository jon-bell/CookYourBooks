import { supabase } from '../supabase.js';

export interface CliTokenRow {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export async function listCliTokens(): Promise<CliTokenRow[]> {
  const { data, error } = await supabase
    .from('cli_tokens')
    .select('id, name, prefix, created_at, last_used_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as CliTokenRow[];
}

/**
 * Mints a new token. The raw string is returned only by this call — it
 * never touches the DB in plaintext and cannot be retrieved again. Caller
 * must show it to the user immediately and promptly forget.
 */
export async function issueCliToken(name: string): Promise<string> {
  const { data, error } = await supabase.rpc('cli_issue_token', {
    token_name: name,
  });
  if (error) throw error;
  if (typeof data !== 'string') throw new Error('Issue returned no token');
  return data;
}

export async function revokeCliToken(id: string): Promise<void> {
  // `cli_tokens_delete_own` RLS policy lets the owner delete through
  // PostgREST directly.
  const { error } = await supabase.from('cli_tokens').delete().eq('id', id);
  if (error) throw error;
}
