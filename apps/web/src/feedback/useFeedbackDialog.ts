import { useCallback, useEffect, useState } from 'react';

import { retryPendingFeedback } from './api.js';
import { subscribeOpenFeedback } from './open.js';

/**
 * Owns the single feedback dialog's open state at the app root, and drains any
 * reports that were queued while offline.
 *
 * Retry fires on mount and whenever connectivity returns — those are the two
 * moments a queued report can actually go out, and both are cheap no-ops when
 * the queue is empty.
 */
export function useFeedbackDialog(): { open: boolean; close: () => void } {
  const [open, setOpen] = useState(false);

  useEffect(() => subscribeOpenFeedback(() => setOpen(true)), []);

  useEffect(() => {
    const drain = () => {
      void retryPendingFeedback().catch(() => {
        // Still offline or still failing — the queue keeps the report.
      });
    };
    drain();
    window.addEventListener('online', drain);
    return () => window.removeEventListener('online', drain);
  }, []);

  const close = useCallback(() => setOpen(false), []);
  return { open, close };
}
