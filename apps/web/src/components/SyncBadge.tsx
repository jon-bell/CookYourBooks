import { useState } from 'react';
import { useSync } from '../local/SyncProvider.js';
import { SyncDebugDialog } from './SyncDebugDialog.js';

const LABEL: Record<string, { text: string; tone: string }> = {
  initializing: { text: 'Starting…', tone: 'bg-stone-100 text-stone-600' },
  idle: { text: 'Synced', tone: 'bg-emerald-50 text-emerald-700' },
  syncing: { text: 'Syncing…', tone: 'bg-amber-50 text-amber-800' },
  error: { text: 'Sync error', tone: 'bg-red-50 text-red-700' },
  offline: { text: 'Offline', tone: 'bg-stone-100 text-stone-700' },
};

export function SyncBadge() {
  const { status, pendingWrites, lastSyncedAt, lastError } = useSync();
  const { text, tone } = LABEL[status] ?? LABEL.idle!;
  const [open, setOpen] = useState(false);
  const errorHint = status === 'error' ? shortError(lastError) : '';
  const suffix =
    errorHint
      ? ` · ${errorHint}`
      : pendingWrites > 0
        ? ` · ${pendingWrites} queued`
        : lastSyncedAt && status === 'idle'
          ? ` · ${relativeTime(lastSyncedAt)}`
          : '';
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={lastError ?? 'Open sync diagnostics'}
        aria-live="polite"
        aria-label={`Sync status: ${text}${suffix ? `, ${suffix.replace(/^ · /, '')}` : ''}. Open diagnostics.`}
        className={`max-w-xs truncate rounded-full px-2.5 py-1 text-xs font-medium transition ${tone} hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600`}
      >
        {text}
        {suffix}
      </button>
      <SyncDebugDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function shortError(msg: string | null): string {
  if (!msg) return 'unknown error';
  const line = msg.split('\n')[0] ?? msg;
  return line.length > 72 ? `${line.slice(0, 69)}…` : line;
}

function relativeTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 10_000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}
