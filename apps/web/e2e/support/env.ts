import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Supabase connection info for the E2E suite.
//
// Order of resolution:
//   1. `TEST_SUPABASE_URL` / `TEST_SUPABASE_ANON_KEY` /
//      `TEST_SUPABASE_SERVICE_ROLE` env vars (set explicitly by CI or by
//      an operator pointing at a non-default Supabase).
//   2. `supabase status --output json` against the vendored CLI — reads
//      the live keys out of the running local stack.
//
// Hardcoding the dev-default keys in source looks convenient but trips
// GitHub's secret scanner, so we avoid it entirely.

const envUrl = process.env.TEST_SUPABASE_URL;
const envAnon = process.env.TEST_SUPABASE_ANON_KEY;
const envServiceRole = process.env.TEST_SUPABASE_SERVICE_ROLE;

function findRepoRoot(): string {
  // Walk upward from cwd looking for the vendored CLI. Works whether the
  // test runner was invoked from the repo root, from `apps/web`, or from
  // Playwright's own working directory.
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(resolve(dir, '.bin/supabase'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    '.bin/supabase not found in any parent directory. ' +
      'Run `scripts/install-supabase-cli.sh` (see CLAUDE.md).',
  );
}

function readFromSupabaseCli(): {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
} {
  const root = findRepoRoot();
  const raw = execFileSync(resolve(root, '.bin/supabase'), ['status', '--output', 'json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(raw) as {
    API_URL?: string;
    ANON_KEY?: string;
    SERVICE_ROLE_KEY?: string;
  };
  if (!parsed.API_URL || !parsed.ANON_KEY || !parsed.SERVICE_ROLE_KEY) {
    throw new Error(
      'supabase status did not return API_URL / ANON_KEY / SERVICE_ROLE_KEY — ' +
        'is the stack running? Try `./.bin/supabase start`.',
    );
  }
  return {
    apiUrl: parsed.API_URL,
    anonKey: parsed.ANON_KEY,
    serviceRoleKey: parsed.SERVICE_ROLE_KEY,
  };
}

const resolved =
  envUrl && envAnon && envServiceRole
    ? { apiUrl: envUrl, anonKey: envAnon, serviceRoleKey: envServiceRole }
    : readFromSupabaseCli();

export const SUPABASE_URL = resolved.apiUrl;
export const SUPABASE_ANON_KEY = resolved.anonKey;
export const SUPABASE_SERVICE_ROLE = resolved.serviceRoleKey;
