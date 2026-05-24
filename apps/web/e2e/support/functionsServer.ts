import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${FUNCTIONS_BASE_URL}/import-worker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    throw new Error(`Supabase CLI not found at ${SUPABASE_BIN}. Run scripts/install-supabase-cli.sh.`);
  }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ENV_FILE, 'OCR_MOCK_MODE=1\n');

  const child: ChildProcess = spawn(
    SUPABASE_BIN,
    ['functions', 'serve', 'import-worker', '--no-verify-jwt', '--env-file', ENV_FILE],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', () => undefined);
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
