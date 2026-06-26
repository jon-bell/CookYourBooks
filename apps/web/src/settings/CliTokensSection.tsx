import { useEffect, useState } from 'react';

import { LoadingState } from '../components/LoadingState.js';
import { type CliTokenRow, issueCliToken, listCliTokens, revokeCliToken } from './cliTokens.js';

/**
 * CLI tokens UI block. Drops into the Settings page. List + create +
 * revoke. The create flow is modal-esque — a panel that renders the raw
 * token once, with a copy button, and warns the user that it won't be
 * shown again.
 */
export function CliTokensSection() {
  const [tokens, setTokens] = useState<CliTokenRow[] | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [justIssued, setJustIssued] = useState<{ name: string; raw: string } | undefined>();

  async function refresh() {
    try {
      setTokens(await listCliTokens());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => void refresh(), []);

  async function handleIssue(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setIssuing(true);
    setError(null);
    try {
      const raw = await issueCliToken(name.trim());
      setJustIssued({ name: name.trim(), raw });
      setName('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIssuing(false);
    }
  }

  async function handleRevoke(id: string, displayName: string) {
    if (!confirm(`Revoke token "${displayName}"? Any CLI using it will stop working.`)) return;
    try {
      await revokeCliToken(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Best-effort — fall through to the manual select/copy.
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-5">
      <div>
        <h2 className="text-lg font-semibold">CLI tokens</h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Generate a token to drive the{' '}
          <code className="rounded bg-stone-100 dark:bg-stone-800 px-1">cyb</code> command-line tool
          for scripted import/export. A token is shown once — copy it to a password manager or{' '}
          <code className="rounded bg-stone-100 dark:bg-stone-800 px-1">cyb login</code>{' '}
          immediately. Tokens only grant access to your own recipes.
        </p>
      </div>

      <form onSubmit={handleIssue} className="flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[220px]">
          <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-300">
            New token label
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My laptop"
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={issuing || !name.trim()}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
        >
          {issuing ? 'Creating…' : 'Create token'}
        </button>
      </form>

      {justIssued && (
        <div
          role="status"
          className="space-y-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-200"
        >
          <div className="font-medium">
            Token "{justIssued.name}" created. Copy it now — you won't see it again.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-white dark:bg-stone-900 px-3 py-2 font-mono text-xs text-stone-800 dark:text-stone-200 ring-1 ring-amber-200">
              {justIssued.raw}
            </code>
            <button
              onClick={() => copy(justIssued.raw)}
              className="rounded-md bg-amber-900 px-3 py-2 text-xs font-medium text-white hover:bg-amber-800"
            >
              Copy
            </button>
          </div>
          <button
            onClick={() => setJustIssued(undefined)}
            className="text-xs text-amber-800 dark:text-amber-300 underline"
          >
            I've saved it — dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="rounded border border-red-200 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {tokens === undefined ? (
        <LoadingState surface="settings-cli" size="inline" />
      ) : tokens.length === 0 ? (
        <p className="text-sm text-stone-600 dark:text-stone-400">No CLI tokens yet.</p>
      ) : (
        <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-md border border-stone-200 dark:border-stone-700">
          {tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <div className="flex-1">
                <div className="font-medium">{t.name}</div>
                <div className="mt-0.5 font-mono text-xs text-stone-500 dark:text-stone-400">
                  {t.prefix}… · created {formatWhen(t.created_at)}
                  {t.last_used_at ? ` · last used ${formatWhen(t.last_used_at)}` : ' · never used'}
                </div>
              </div>
              <button
                onClick={() => handleRevoke(t.id, t.name)}
                className="rounded-md px-3 py-1.5 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatWhen(iso: string): string {
  const ts = new Date(iso).getTime();
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
