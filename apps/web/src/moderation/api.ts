import { supabase } from '../supabase.js';

// Thin wrapper over the moderation RPCs + tables. These calls go straight
// to Supabase rather than through cr-sqlite — moderation state is admin-
// scoped and doesn't benefit from local caching.

export type ReportReason = 'SPAM' | 'OFF_TOPIC' | 'OFFENSIVE' | 'COPYRIGHT' | 'OTHER';
export type ReportStatus = 'OPEN' | 'ACTIONED' | 'DISMISSED';
export type ReportTargetType = 'COLLECTION' | 'RECIPE' | 'USER';

export interface Report {
  id: string;
  reporter_id: string | null;
  target_type: ReportTargetType;
  target_id: string;
  reason: ReportReason;
  message: string | null;
  status: ReportStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export async function submitReport(params: {
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  message?: string;
}): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('Sign in to report content.');
  const { error } = await supabase.from('reports').insert({
    reporter_id: userId,
    target_type: params.targetType,
    target_id: params.targetId,
    reason: params.reason,
    message: params.message?.trim() || null,
  });
  if (error) throw error;
}

export async function listReports(status: ReportStatus = 'OPEN'): Promise<Report[]> {
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as Report[];
}

// ---------- Admin actions ----------

export async function unpublishCollection(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('moderation_unpublish_collection', {
    target_collection_id: id,
    reason,
  });
  if (error) throw error;
}

export async function republishCollection(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('moderation_republish_collection', {
    target_collection_id: id,
    reason,
  });
  if (error) throw error;
}

export async function banUser(userId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('moderation_ban_user', {
    target_user_id: userId,
    reason,
  });
  if (error) throw error;
}

export async function unbanUser(userId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('moderation_unban_user', {
    target_user_id: userId,
    reason,
  });
  if (error) throw error;
}

export async function dismissReport(reportId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('moderation_dismiss_report', {
    target_report_id: reportId,
    note,
  });
  if (error) throw error;
}

export async function grantAdmin(userId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('moderation_grant_admin', {
    target_user_id: userId,
    note,
  });
  if (error) throw error;
}

export async function revokeAdmin(userId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('moderation_revoke_admin', {
    target_user_id: userId,
    reason,
  });
  if (error) throw error;
}

// ---------- Support data ----------

export interface CollectionTarget {
  id: string;
  title: string;
  owner_id: string;
  owner_name: string | null;
  is_public: boolean;
  recipe_count: number;
  disabled_owner: boolean;
}

export async function fetchCollectionTarget(id: string): Promise<CollectionTarget | null> {
  // RLS: admins can read any recipe_collections row. Non-admins only
  // trigger this for collections they themselves reported, which live in
  // the public surface — still readable.
  const { data: col, error } = await supabase
    .from('recipe_collections')
    .select('id, title, owner_id, is_public')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!col) return null;
  const { data: owner } = await supabase
    .from('profiles')
    .select('display_name, disabled')
    .eq('id', col.owner_id)
    .maybeSingle();
  const { count } = await supabase
    .from('recipes')
    .select('id', { head: true, count: 'exact' })
    .eq('collection_id', id);
  return {
    id: col.id,
    title: col.title,
    owner_id: col.owner_id,
    owner_name: owner?.display_name ?? null,
    is_public: col.is_public,
    recipe_count: count ?? 0,
    disabled_owner: !!owner?.disabled,
  };
}

export interface ModerationAction {
  id: string;
  admin_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  created_at: string;
}

export async function listModerationActions(limit = 100): Promise<ModerationAction[]> {
  const { data, error } = await supabase
    .from('moderation_actions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ModerationAction[];
}
