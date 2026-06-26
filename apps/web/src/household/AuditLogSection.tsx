import type { AuditLogRow } from './api.js';
import { useAuditLog } from './queries.js';

const ACTION_LABEL: Record<string, string> = {
  HOUSEHOLD_CREATED: 'Household created',
  HOUSEHOLD_RENAMED: 'Household renamed',
  HOUSEHOLD_DELETED: 'Household deleted',
  MEMBER_INVITED: 'Invite created',
  INVITE_REVOKED: 'Invite revoked',
  MEMBER_JOINED: 'Joined household',
  MEMBER_LEFT: 'Left household',
  MEMBER_REMOVED: 'Member removed',
  OWNERSHIP_TRANSFERRED: 'Ownership transferred',
  COLLECTION_SHARED: 'Collection shared',
  COLLECTION_UNSHARED: 'Collection unshared',
  ATTESTATION_GIVEN: 'Attestation recorded',
  COLLECTION_MADE_PUBLIC: 'Collection made public',
  COLLECTION_UNPUBLISHED: 'Collection unpublished',
  TOS_ACCEPTED: 'Terms accepted',
};

/**
 * Renders the user's audit-log entries (own actions + household
 * actions). RLS handles the visibility filter — this component just
 * displays what the server allows it to see.
 *
 * Attestation text is shown verbatim when present, because that's the
 * primary value of the audit log — proving who attested what when.
 */
export function AuditLogSection() {
  const audit = useAuditLog();
  if (audit.isLoading) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading activity…</p>;
  }
  if (audit.error) {
    return (
      <p className="text-sm text-red-700 dark:text-red-300">
        Couldn't load activity log: {audit.error.message}
      </p>
    );
  }
  const rows = audit.data ?? [];
  if (rows.length === 0) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">No activity yet.</p>;
  }
  return (
    <ol
      data-testid="audit-log"
      className="divide-y divide-stone-200 dark:divide-stone-700 rounded-md border border-stone-200 dark:border-stone-700 text-sm"
    >
      {rows.map((row) => (
        <AuditRow key={row.id} row={row} />
      ))}
    </ol>
  );
}

function AuditRow({ row }: { row: AuditLogRow }) {
  const label = ACTION_LABEL[row.action] ?? row.action;
  const when = new Date(row.created_at).toLocaleString();
  const attestation =
    typeof row.metadata?.attestation === 'string' ? row.metadata.attestation : null;
  return (
    <li className="px-3 py-2" data-testid={`audit-row-${row.action}`}>
      <div className="flex items-center justify-between">
        <span className="font-medium">{label}</span>
        <time className="text-xs text-stone-500 dark:text-stone-400">{when}</time>
      </div>
      {attestation && (
        <p className="mt-1 text-xs italic text-stone-600 dark:text-stone-400">"{attestation}"</p>
      )}
      {row.target_type && row.target_id && (
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          {row.target_type.toLowerCase()} · {row.target_id.slice(0, 8)}…
        </p>
      )}
    </li>
  );
}
