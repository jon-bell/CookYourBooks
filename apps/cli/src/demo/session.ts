import type { Database } from '@cookyourbooks/db';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadConfig } from '../config.js';

// The `demo` commands sign in as a user instead of using a `cyb_cli_*` token:
// they upload page images to Storage and write import rows exactly as the app
// does, and Storage only accepts a user JWT. The session lives in memory for
// the one run — nothing is written to the config file, and the password is
// read from the environment so it never lands in shell history or `ps`.

export type DemoClient = SupabaseClient<Database>;

export interface SessionOptions {
  url?: string;
  anonKey?: string;
  email?: string;
  /** Name of the env var holding the password (default CYB_PASSWORD). */
  passwordEnv: string;
}

export async function signIn(
  opts: SessionOptions,
): Promise<{ client: DemoClient; userId: string; email: string }> {
  const saved = loadConfig();
  const url = opts.url ?? process.env.CYB_SUPABASE_URL ?? saved?.url;
  const anonKey = opts.anonKey ?? process.env.CYB_SUPABASE_ANON_KEY ?? saved?.anonKey;
  const email = opts.email ?? process.env.CYB_EMAIL;
  const password = process.env[opts.passwordEnv];
  if (!url || !anonKey) {
    throw new Error(
      'No Supabase URL / anon key. Pass --url and --anon-key, set CYB_SUPABASE_URL and ' +
        'CYB_SUPABASE_ANON_KEY, or run `cyb login` once.',
    );
  }
  if (!email) throw new Error('No account. Pass --email or set CYB_EMAIL.');
  if (!password) throw new Error(`Set the account password in $${opts.passwordEnv}.`);

  const client = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: true },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed: ${error.message}`);
  return { client, userId: data.user.id, email };
}
