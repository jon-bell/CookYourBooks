import { useState } from 'react';
import { submitReport, type ReportReason, type ReportTargetType } from './api.js';

const REASON_LABELS: Record<ReportReason, string> = {
  SPAM: 'Spam or scam',
  OFF_TOPIC: 'Not a recipe / off-topic',
  OFFENSIVE: 'Offensive content',
  COPYRIGHT: 'Copyright violation',
  OTHER: 'Other',
};

/** Modal form for reporting any moderatable target. Self-contained — the
 *  parent only needs to pass an `onClose` callback. */
export function ReportDialog({
  open,
  onClose,
  targetType,
  targetId,
  targetLabel,
}: {
  open: boolean;
  onClose: () => void;
  targetType: ReportTargetType;
  targetId: string;
  targetLabel: string;
}) {
  const [reason, setReason] = useState<ReportReason>('SPAM');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await submitReport({ targetType, targetId, reason, message });
      setSent(true);
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
      aria-label="Report content"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg ring-1 ring-stone-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Report this {targetType.toLowerCase()}</h2>
          <p className="mt-1 text-sm text-stone-600">"{targetLabel}"</p>
        </div>

        {sent ? (
          <div className="space-y-4">
            <p className="text-sm text-stone-700">
              Thanks — an admin will review this report shortly.
            </p>
            <button
              onClick={onClose}
              className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-stone-700">Reason</span>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value as ReportReason)}
                className="w-full rounded border border-stone-300 px-3 py-2"
              >
                {Object.entries(REASON_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-stone-700">
                Details (optional)
              </span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                maxLength={1000}
                placeholder="Anything an admin should know?"
                className="w-full rounded border border-stone-300 px-3 py-2 text-sm"
              />
            </label>

            {error && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={submitting}
                className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
              >
                {submitting ? 'Submitting…' : 'Submit report'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-4 py-2 text-sm text-stone-600 hover:text-stone-900"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
