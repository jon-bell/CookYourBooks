import { useEffect, useRef, useState } from 'react';

/**
 * Replacement for `window.prompt`. Used when an admin confirms a
 * moderation action (take-down, ban, dismiss, restore) so the reason text
 * lands in `moderation_actions` and is visible on the log. Supports Enter
 * to submit and Escape to cancel.
 */
export function ReasonDialog({
  open,
  title,
  description,
  placeholder,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string;
  placeholder?: string;
  confirmLabel: string;
  /** Tints the confirm button red when this is a destructive action. */
  danger?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
      setSubmitting(false);
      // Focus the input on open.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(reason);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onCancel}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg ring-1 ring-stone-200"
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-stone-600">{description}</p>}

        <label className="mt-4 block">
          <span className="mb-1 block text-sm font-medium text-stone-700">
            Reason (logged publicly in the audit trail)
          </span>
          <input
            ref={inputRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={placeholder ?? 'Short explanation…'}
            maxLength={500}
            className="w-full rounded border border-stone-300 px-3 py-2 text-sm"
          />
        </label>

        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-5 flex gap-3">
          <button
            type="submit"
            disabled={submitting || !reason.trim()}
            className={`rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${
              danger ? 'bg-red-700 hover:bg-red-800' : 'bg-stone-900 hover:bg-stone-800'
            }`}
          >
            {submitting ? 'Working…' : confirmLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-4 py-2 text-sm text-stone-600 hover:text-stone-900"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
