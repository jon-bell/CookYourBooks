import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Config lives in the user's XDG config dir (or the equivalent on macOS
// / Windows). File mode is 0600 so other users on a shared host can't
// slurp the token.
export interface CliConfig {
  /** Supabase project URL, e.g. https://abcd.supabase.co */
  url: string;
  /** The project's public anon key (safe to store; same value anyone
   *  else can see in the web app's client bundle). */
  anonKey: string;
  /** The `cyb_cli_*` secret token. This is the real credential. */
  token: string;
}

function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const root = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(root, 'cookyourbooks', 'config.json');
}

export function loadConfig(): CliConfig | undefined {
  const path = configPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CliConfig>;
    if (!parsed.url || !parsed.anonKey || !parsed.token) return undefined;
    return { url: parsed.url, anonKey: parsed.anonKey, token: parsed.token };
  } catch {
    return undefined;
  }
}

export function saveConfig(config: CliConfig): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows / restricted filesystems — best effort.
  }
  return path;
}

export function requireConfig(): CliConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error(
      'Not logged in. Run `cyb login --url <supabase-url> --anon-key <key> --token <token>` first.',
    );
  }
  return config;
}
