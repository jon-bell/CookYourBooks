// Feedback data access. Like the LLM Cost Center and Data Usage, this is an
// ONLINE-only surface: it reads `public.feedback_reports` through PostgREST
// under RLS rather than the local-first SQLite cache.
//
// A submit fans out to two sinks on purpose:
//   * Sentry, which already carries breadcrumbs, device context and the release
//     tag, and is where the developer triages runtime problems;
//   * the `feedback_reports` table, which is the durable, in-app-readable
//     record and survives Sentry's retention.
// Sentry goes first so its event id can be stored on the row — that's the
// direction triage actually travels (read the report, jump to the event).
//
// The `feedback_reports` table + `feedback_submit` RPC are created by
// 20260713000000 but aren't in the checked-in generated Supabase types yet
// (regenerated from the schema out of band, like every new relation), hence the
// `never` casts at the PostgREST boundary.

import { Sentry } from '../sentry.js';
import { supabase } from '../supabase.js';
import { collectFeedbackPayload, type FeedbackKind, type FeedbackPayload } from './payload.js';
import { flushPending, type PendingReport, queuePending } from './pending.js';

export type FeedbackStatus = 'new' | 'triaged' | 'closed';

export interface FeedbackReportRow {
  id: string;
  owner_id: string;
  household_id: string | null;
  kind: FeedbackKind;
  body: string;
  payload: FeedbackPayload | null;
  release: string | null;
  platform: string | null;
  route: string | null;
  sentry_event_id: string | null;
  status: FeedbackStatus;
  created_at: string;
}

export interface SubmitFeedbackInput {
  kind: FeedbackKind;
  body: string;
  /** Where the user was when they opened the dialog. */
  route: string;
}

export type SubmitFeedbackResult =
  | { status: 'sent'; id: string; sentryEventId: string | null }
  | { status: 'queued' };

/**
 * Send the report to Sentry. Never throws — a failure here must not stop the
 * durable row from being written, which is the whole point of having two sinks.
 */
async function sendToSentry(
  input: SubmitFeedbackInput,
  payload: FeedbackPayload,
): Promise<string | null> {
  try {
    const eventId = Sentry.withScope((scope) => {
      scope.setTag('report', 'feedback');
      scope.setTag('feedback_kind', input.kind);
      scope.setLevel(input.kind === 'bug' ? 'error' : 'info');
      // Small queryable facets for the issue list; the bulk rides in the
      // attachment, which isn't subject to Sentry's per-field truncation.
      scope.setContext('feedback', {
        kind: input.kind,
        route: input.route,
        release: payload.device.release,
        platform: payload.device.platform,
        online: payload.device.online,
        breadcrumbCount: payload.breadcrumbs.length,
      });
      scope.addAttachment({
        filename: 'feedback-payload.json',
        data: JSON.stringify(payload, null, 2),
        contentType: 'application/json',
      });
      const title = input.body.replace(/\s+/g, ' ').trim().slice(0, 120);
      return Sentry.captureMessage(`Feedback (${input.kind}): ${title}`, undefined);
    });
    if (!eventId) return null;
    // Also land it in Sentry's User Feedback surface, linked to that event.
    try {
      Sentry.captureFeedback({ message: input.body, associatedEventId: eventId });
    } catch {
      // Older SDK without the feedback API — the event + attachment still went.
    }
    // Don't let a slow network hold the dialog open; the row write is what the
    // user is actually waiting on.
    await Sentry.flush(3000);
    return eventId;
  } catch {
    return null;
  }
}

/** Write the durable row. Throws on failure so the caller can queue a retry. */
async function insertReport(
  input: SubmitFeedbackInput,
  payload: FeedbackPayload,
  sentryEventId: string | null,
): Promise<string> {
  const { data, error } = await supabase.rpc(
    'feedback_submit' as never,
    {
      p_kind: input.kind,
      p_body: input.body,
      p_payload: payload,
      p_release: payload.device.release,
      p_platform: payload.device.platform,
      p_route: input.route,
      p_sentry_event_id: sentryEventId,
    } as never,
  );
  if (error) throw error;
  return data;
}

/**
 * A failure we should retry rather than show as a validation error. The RPC
 * raises with real SQLSTATEs (22023 bad kind, 28000 unauthenticated, 22001 too
 * large); a transport failure arrives with no usable code.
 */
function isRetryable(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  const code = (err as { code?: string } | null | undefined)?.code;
  return !code;
}

/**
 * Submit a report to both sinks. A transport failure queues the report for a
 * later retry and reports `queued` rather than throwing; a rejection by the
 * server (bad kind, too large, signed out) throws so the user sees why.
 */
export async function submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
  const payload = collectFeedbackPayload();
  const sentryEventId = await sendToSentry(input, payload);
  try {
    const id = await insertReport(input, payload, sentryEventId);
    return { status: 'sent', id, sentryEventId };
  } catch (err) {
    if (!isRetryable(err)) throw err;
    queuePending(input, payload);
    return { status: 'queued' };
  }
}

/**
 * Retry anything queued while offline. Safe to call on every launch and on
 * `online`; a no-op when the queue is empty.
 */
export async function retryPendingFeedback(): Promise<{ sent: number; remaining: number }> {
  return flushPending(async (p: PendingReport) => {
    const sentryEventId = await sendToSentry(p.input, p.payload);
    await insertReport(p.input, p.payload, sentryEventId);
  });
}

/** The caller's own reports, newest first. */
export async function listMyFeedback(limit = 100): Promise<FeedbackReportRow[]> {
  const { data: session } = await supabase.auth.getUser();
  const uid = session.user?.id;
  let q = supabase
    .from('feedback_reports' as never)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  // RLS would also let an admin see everyone's; scope explicitly so the
  // "my reports" page means what it says even when the viewer is an admin.
  if (uid) q = q.eq('owner_id', uid);
  const { data, error } = await q;
  if (error) throw error;
  // `error` is thrown above, so PostgREST guarantees rows here.
  return data;
}

/** Every report the caller may read. For admins that's all of them (RLS). */
export async function listAllFeedback(
  opts: { status?: FeedbackStatus; limit?: number } = {},
): Promise<FeedbackReportRow[]> {
  let q = supabase
    .from('feedback_reports' as never)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.status) q = q.eq('status', opts.status);
  const { data, error } = await q;
  if (error) throw error;
  // `error` is thrown above, so PostgREST guarantees rows here.
  return data;
}

/** Triage. Admin-only at the policy level; the UI just hides the control. */
export async function setFeedbackStatus(id: string, status: FeedbackStatus): Promise<void> {
  const { error } = await supabase
    .from('feedback_reports' as never)
    .update({ status } as never)
    .eq('id', id);
  if (error) throw error;
}
