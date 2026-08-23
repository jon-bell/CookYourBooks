/**
 * Durable holding pen for reports that couldn't reach the server.
 *
 * Sync problems are exactly the ones a user is offline for when they hit them,
 * so losing the report on a failed submit would drop the most valuable class of
 * bug. Routing it through the CRR `outbox` would be the "proper" answer, but
 * that machinery is built around syncing domain tables — localStorage plus a
 * retry on launch and on `online` gets the same durability for a fraction of
 * the surface area.
 *
 * The captured payload is stored as-is rather than re-collected at send time:
 * the evidence that matters is the state when the bug happened, not the state
 * whenever connectivity came back.
 */

import type { SubmitFeedbackInput } from './api.js';
import type { FeedbackPayload } from './payload.js';

const KEY = 'cookyourbooks.feedback.pending.v1';
/** A backlog this long means something is badly wrong; don't fill the quota. */
const MAX_QUEUED = 5;

export interface PendingReport {
  input: SubmitFeedbackInput;
  payload: FeedbackPayload;
  queuedAt: number;
}

export function readPending(): PendingReport[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingReport[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Private mode / corrupt entry — start clean rather than break the app.
    return [];
  }
}

function write(list: PendingReport[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Quota or private mode. The report is lost, but the submit already
    // reported failure to the user, so nothing is silently swallowed.
  }
}

export function queuePending(input: SubmitFeedbackInput, payload: FeedbackPayload): void {
  const list = readPending();
  list.push({ input, payload, queuedAt: Date.now() });
  write(list.slice(-MAX_QUEUED));
}

export function clearPending(): void {
  write([]);
}

/**
 * Try to send everything queued. Stops at the first failure and keeps the
 * remainder — the next trigger retries in order.
 *
 * `send` is injected so this module stays free of the Supabase client and can
 * be unit tested directly.
 */
export async function flushPending(
  send: (p: PendingReport) => Promise<void>,
): Promise<{ sent: number; remaining: number }> {
  const list = readPending();
  if (list.length === 0) return { sent: 0, remaining: 0 };
  let sent = 0;
  for (const item of list) {
    try {
      await send(item);
      sent += 1;
    } catch {
      break;
    }
  }
  const remaining = list.slice(sent);
  write(remaining);
  return { sent, remaining: remaining.length };
}
