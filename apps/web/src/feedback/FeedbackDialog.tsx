import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { submitFeedback } from './api.js';
import { getBreadcrumbs } from './breadcrumbs.js';
import type { FeedbackKind } from './payload.js';

type SendState =
  | { state: 'idle' }
  | { state: 'sending' }
  | { state: 'sent'; queued: boolean }
  | { state: 'error'; message: string };

/**
 * Filing happens in a dialog over the current page rather than on its own
 * route. Two reasons: the breadcrumb trail stays pointed at where the user
 * actually was, and navigating away to a form would itself become the last
 * thing in the trail.
 */
export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const location = useLocation();
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [body, setBody] = useState('');
  const [send, setSend] = useState<SendState>({ state: 'idle' });
  // Mounted only while open (see App.tsx), so this lazy initializer snapshots
  // the trail length at open time — opening the dialog adds a click crumb of
  // its own, and the number shouldn't tick while the user types.
  const [crumbCount] = useState(() => getBreadcrumbs().length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function onSubmit() {
    const text = body.trim();
    if (!text) return;
    setSend({ state: 'sending' });
    try {
      const result = await submitFeedback({
        kind,
        body: text,
        route: location.pathname + location.search,
      });
      setSend({ state: 'sent', queued: result.status === 'queued' });
      setBody('');
      // Leave the confirmation up briefly so it's actually read.
      setTimeout(() => {
        setSend({ state: 'idle' });
        onClose();
      }, 2200);
    } catch (err) {
      setSend({
        state: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Send feedback"
      // z-[60]: clears the mobile-nav sheet (z-50) it can be opened from.
      className="fixed inset-0 z-[60] flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-lg bg-white shadow-lg ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-700"
      >
        <header className="flex items-center justify-between gap-2 border-b border-stone-200 px-5 py-3 dark:border-stone-700">
          <h2 className="text-base font-semibold">Send feedback</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 py-1 text-sm text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
          >
            ✕
          </button>
        </header>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <div role="radiogroup" aria-label="Report type" className="flex gap-2">
            {(['bug', 'feature'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={`rounded-full px-3 py-1 text-sm ${
                  kind === k
                    ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                    : 'border border-stone-300 hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800'
                }`}
              >
                {k === 'bug' ? 'Something is broken' : 'Feature request'}
              </button>
            ))}
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">
              {kind === 'bug' ? 'What happened?' : 'What would you like?'}
            </span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              autoFocus
              placeholder={
                kind === 'bug'
                  ? 'Going back to search clears my results…'
                  : "I'd love to be able to…"
              }
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm dark:border-stone-600 dark:bg-stone-950"
            />
          </label>

          <p className="text-xs text-stone-500 dark:text-stone-400">
            Sent with the last {crumbCount} {crumbCount === 1 ? 'thing' : 'things'} you did — pages
            opened and buttons tapped, which can include recipe names — plus any recent errors and
            your app version and device, so the problem can be traced without a back-and-forth.
            Recipe contents and photos are not included.
          </p>

          {send.state === 'error' && (
            <p className="text-xs text-red-700 dark:text-red-400">
              Couldn&apos;t send: {send.message}
            </p>
          )}
          {send.state === 'sent' && (
            <p className="text-xs text-green-700 dark:text-green-400">
              {send.queued
                ? "Saved — you're offline, so it'll send once you're back on."
                : 'Thanks — sent.'}
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-stone-200 px-5 py-3 dark:border-stone-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={!body.trim() || send.state === 'sending'}
            className="rounded bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
          >
            {send.state === 'sending' ? 'Sending…' : 'Send'}
          </button>
        </footer>
      </div>
    </div>
  );
}
