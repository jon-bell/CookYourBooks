import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPABASE_SERVICE_ROLE } from './env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const SUPABASE_BIN = resolve(REPO_ROOT, '.bin/supabase');
const STATE_DIR = resolve(REPO_ROOT, 'apps/web/e2e/.tmp');
const STATE_FILE = resolve(STATE_DIR, 'functions-server.json');
const ENV_FILE = resolve(STATE_DIR, 'functions.env');

const FUNCTIONS_BASE_URL = 'http://127.0.0.1:54421/functions/v1';

interface ServerState {
  pid: number;
}

async function pingFunction(timeoutMs: number): Promise<boolean> {
  // The function does its own bearer check (see authorized() in
  // supabase/functions/import-worker/index.ts) — anything without the
  // matching service-role token gets a 401 from the function itself,
  // not the gateway. Use the live key from the running stack so the
  // probe actually reaches the worker loop.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${FUNCTIONS_BASE_URL}/import-worker`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
        body: JSON.stringify({ batch_id: null }),
      });
      if (resp.ok) {
        await resp.text();
        return true;
      }
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function startFunctionsServer(): Promise<void> {
  if (!existsSync(SUPABASE_BIN)) {
    throw new Error(
      `Supabase CLI not found at ${SUPABASE_BIN}. Run scripts/install-supabase-cli.sh.`,
    );
  }
  mkdirSync(STATE_DIR, { recursive: true });
  // Mock flags for the LLM-backed functions so E2E never reaches Gemini /
  // oEmbed: import-worker reads OCR_MOCK_MODE, video-import reads
  // VIDEO_IMPORT_MOCK_MODE (both fall back to the ocr_test_fixtures table).
  writeFileSync(ENV_FILE, 'OCR_MOCK_MODE=1\nVIDEO_IMPORT_MOCK_MODE=1\n');

  // Serve every function in supabase/functions (no name = all) so both
  // import-worker and video-import are reachable on the same port.
  const child: ChildProcess = spawn(
    SUPABASE_BIN,
    ['functions', 'serve', '--no-verify-jwt', '--env-file', ENV_FILE],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  // Mirror the function-server logs through to the Playwright runner.
  // We previously swallowed stderr, which made CI failures opaque —
  // the supabase CLI prints "Deno not found" / port-in-use diagnostics
  // to stderr that are exactly what you want to see when the ping
  // times out below.
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[functions-serve] ${chunk}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[functions-serve] ${chunk}`);
  });
  child.on('error', (err) => {
    console.error('[functionsServer] spawn error', err);
  });
  child.unref();
  if (typeof child.pid !== 'number') {
    throw new Error('functions serve: no PID assigned');
  }
  writeFileSync(STATE_FILE, JSON.stringify({ pid: child.pid } satisfies ServerState));

  const ok = await pingFunction(30_000);
  if (!ok) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
    throw new Error(
      'import-worker did not respond within 30s. Check that ./.bin/supabase start is up.',
    );
  }
}

export async function stopFunctionsServer(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ServerState;
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  } catch {
    /* ignore */
  } finally {
    try {
      unlinkSync(STATE_FILE);
    } catch {
      /* ignore */
    }
  }
}

export const FUNCTIONS_URL = FUNCTIONS_BASE_URL;
