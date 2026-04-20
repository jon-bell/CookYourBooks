import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The shape-tolerant parser lives inside `index.ts` and isn't exported,
// so we exercise it via the compiled binary. That keeps the test honest
// about what ships vs what's exported.
//
// Alternative would be to lift `extractRecipes` into its own module; the
// extra surface isn't worth it for a 15-line helper.

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist', 'index.js');

function runCli(args: string[], env: Record<string, string> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync('node', [DIST, ...args], {
      env: { ...process.env, ...env, XDG_CONFIG_HOME: '/tmp/cyb-test-noop' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? null,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

describe('cyb cli', () => {
  it('refuses to save a token without the cyb_cli_ prefix', () => {
    const result = runCli([
      'login',
      '--url',
      'http://127.0.0.1:54421',
      '--anon-key',
      'ignored',
      '--token',
      'not-a-real-token',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/must start with "cyb_cli_"/);
  });

  it('errors out when whoami has no config', () => {
    const result = runCli(['whoami'], { XDG_CONFIG_HOME: '/tmp/cyb-missing-cfg' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Not logged in/);
  });

  it('import without login prints a useful message', () => {
    const result = runCli(['import', '/nonexistent.json'], {
      XDG_CONFIG_HOME: '/tmp/cyb-missing-cfg',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Not logged in/);
  });

  // Keep this file honest: if the compiled binary isn't there, surface
  // that clearly rather than the opaque ENOENT.
  it('has a compiled binary we can run', () => {
    const shebang = readFileSync(DIST, 'utf8').split('\n')[0];
    expect(shebang).toBe('#!/usr/bin/env node');
  });

  it('exposes toc export/import under the toc subcommand', () => {
    const result = runCli(['toc', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\bexport\b/);
    expect(result.stdout).toMatch(/\bimport\b/);
  });

  it('toc import without login prints a useful message', () => {
    const result = runCli(
      ['toc', 'import', '/nonexistent.txt', '--collection', '00000000-0000-0000-0000-000000000000'],
      { XDG_CONFIG_HOME: '/tmp/cyb-missing-cfg' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Not logged in/);
  });
});
