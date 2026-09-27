import { useState } from 'react';

import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../supabase.js';
import { cliSetupSteps } from './cliSetup.js';

/**
 * Copy-paste instructions for the `cyb` CLI, with this build's Supabase URL
 * and anon key already in the `cyb login` command (and a just-created token,
 * when there is one), so nobody has to go hunting for them.
 */
export function CliSetupSection({ token }: { token?: string }) {
  const steps = cliSetupSteps({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, token });
  return (
    <section
      data-testid="cli-setup"
      className="space-y-4 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-5"
    >
      <div>
        <h2 className="text-lg font-semibold">Set up the cyb CLI</h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Export your library, import recipes from JSON, and seed cookbook tables of contents from a
          terminal.
        </p>
      </div>
      <ol className="space-y-4">
        {steps.map((step, i) => (
          <li key={step.title} className="space-y-1.5">
            <div className="text-sm font-medium">
              {i + 1}. {step.title}
            </div>
            <CommandBlock command={step.command} label={step.title} />
            {step.note && <p className="text-xs text-stone-500 dark:text-stone-400">{step.note}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function CommandBlock({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — the text is selectable.
    }
  }
  return (
    <div className="flex items-start gap-2">
      <pre className="flex-1 overflow-x-auto rounded bg-stone-100 dark:bg-stone-800 px-3 py-2 font-mono text-xs text-stone-800 dark:text-stone-200">
        <code>{command}</code>
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy: ${label}`}
        className="rounded-md border border-stone-300 dark:border-stone-600 px-2.5 py-1.5 text-xs hover:bg-stone-50 dark:hover:bg-stone-800"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
