import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canonicalUnitName,
  conversionRule,
  type ConversionRule,
  type ConversionRulePriority,
} from '@cookyourbooks/domain';
import { useAuth } from '../auth/AuthProvider.js';
import { useLocalQueryEnabled, useSync } from '../local/SyncProvider.js';
import { getLocalDb } from '../local/db.js';
import { enqueue } from '../local/outbox.js';
import { supabase } from '../supabase.js';

// ---------- Types ----------

export interface HouseConversionRule {
  id: string;
  ownerId: string;
  fromUnit: string;
  toUnit: string;
  factor: number;
  ingredientName: string | null;
  notes: string | null;
}

export interface GlobalConversionRule {
  id: string;
  fromUnit: string;
  toUnit: string;
  factor: number;
  ingredientName: string | null;
  notes: string | null;
}

interface LocalRow {
  id: string;
  owner_id: string;
  from_unit: string;
  to_unit: string;
  factor: number;
  ingredient_name: string | null;
  notes: string | null;
  deleted: number;
}

// ---------- Local-first HOUSE rules ----------

async function listHouseRulesLocal(ownerId: string): Promise<HouseConversionRule[]> {
  const db = await getLocalDb();
  const rows = (await db.execO<LocalRow>(
    `select id, owner_id, from_unit, to_unit, factor, ingredient_name, notes, deleted
       from conversion_rules
      where owner_id = ?
        and deleted = 0
        and priority = 'HOUSE'
      order by coalesce(ingredient_name, '') asc, from_unit asc, to_unit asc`,
    [ownerId],
  )) as LocalRow[];
  return rows.map((r) => ({
    id: r.id,
    ownerId: r.owner_id,
    fromUnit: r.from_unit,
    toUnit: r.to_unit,
    factor: Number(r.factor),
    ingredientName: r.ingredient_name,
    notes: r.notes,
  }));
}

async function writeHouseRuleLocal(rule: HouseConversionRule): Promise<void> {
  const db = await getLocalDb();
  const now = Date.now();
  // Local-first: stamp updated_at = now() so a subsequent pull doesn't
  // clobber the change before the outbox push lands. The server's
  // trigger will overwrite updated_at on the next sync, which is fine.
  await db.exec(
    `insert into conversion_rules
       (id, owner_id, recipe_id, from_unit, to_unit, factor,
        ingredient_name, notes, priority, updated_at, deleted)
     values (?,?,?,?,?,?,?,?, 'HOUSE', ?, 0)
     on conflict(id) do update set
       from_unit=excluded.from_unit,
       to_unit=excluded.to_unit,
       factor=excluded.factor,
       ingredient_name=excluded.ingredient_name,
       notes=excluded.notes,
       updated_at=excluded.updated_at,
       deleted=0`,
    [
      rule.id,
      rule.ownerId,
      null,
      rule.fromUnit,
      rule.toUnit,
      rule.factor,
      rule.ingredientName,
      rule.notes,
      now,
    ],
  );
  await enqueue({ kind: 'conversion_rule_save', entity_id: rule.id });
}

async function softDeleteHouseRuleLocal(id: string): Promise<void> {
  const db = await getLocalDb();
  const now = Date.now();
  await db.exec(
    `update conversion_rules
        set deleted = 1, updated_at = ?
      where id = ?`,
    [now, id],
  );
  await enqueue({ kind: 'conversion_rule_delete', entity_id: id });
}

export function useHouseConversionRules() {
  const { user } = useAuth();
  const enabled = useLocalQueryEnabled();
  return useQuery<HouseConversionRule[]>({
    queryKey: ['conversion-rules', 'house', user?.id],
    enabled: enabled && !!user,
    queryFn: () => listHouseRulesLocal(user!.id),
  });
}

export function useUpsertHouseConversionRule() {
  const { user } = useAuth();
  const { syncNow } = useSync();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: string;
      fromUnit: string;
      toUnit: string;
      factor: number;
      ingredientName: string | null;
      notes: string | null;
    }) => {
      if (!user) throw new Error('Sign in required');
      const rule: HouseConversionRule = {
        id: input.id ?? crypto.randomUUID(),
        ownerId: user.id,
        fromUnit: input.fromUnit.toLowerCase(),
        toUnit: input.toUnit.toLowerCase(),
        factor: input.factor,
        ingredientName: input.ingredientName
          ? input.ingredientName.trim().toLowerCase()
          : null,
        notes: input.notes && input.notes.trim() !== '' ? input.notes.trim() : null,
      };
      await writeHouseRuleLocal(rule);
      return rule;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversion-rules', 'house', user?.id] });
      void syncNow();
    },
  });
}

export function useDeleteHouseConversionRule() {
  const { user } = useAuth();
  const { syncNow } = useSync();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await softDeleteHouseRuleLocal(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversion-rules', 'house', user?.id] });
      void syncNow();
    },
  });
}

// ---------- Server-only GLOBAL rules ----------
//
// Globals are shared across users and tiny — no point flooding the
// per-user cr-sqlite cache with them. Fetch via React Query and
// invalidate on the realtime channel.

async function listGlobalRulesRemote(): Promise<GlobalConversionRule[]> {
  const { data, error } = await supabase
    .from('global_conversions')
    .select('id, from_unit, to_unit, factor, ingredient_name, notes')
    .order('ingredient_name', { ascending: true, nullsFirst: true })
    .order('from_unit', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    fromUnit: row.from_unit,
    toUnit: row.to_unit,
    factor: Number(row.factor),
    ingredientName: row.ingredient_name,
    notes: row.notes,
  }));
}

export function useGlobalConversionRules() {
  const qc = useQueryClient();
  const query = useQuery<GlobalConversionRule[]>({
    queryKey: ['conversion-rules', 'global'],
    queryFn: listGlobalRulesRemote,
    staleTime: 10 * 60_000,
  });
  // Live updates: any change an admin makes (or a backend job) lands
  // here within the channel's latency. Strictly an invalidation — no
  // attempt to merge the row diff into the cache.
  useEffect(() => {
    const channel = supabase
      .channel('global_conversions:invalidate')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'global_conversions' },
        () => {
          void qc.invalidateQueries({ queryKey: ['conversion-rules', 'global'] });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [qc]);
  return query;
}

// ---------- Admin: mutate globals via RPC ----------

export async function upsertGlobalConversion(input: {
  id?: string;
  fromUnit: string;
  toUnit: string;
  factor: number;
  ingredientName: string | null;
  notes: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('global_conversion_upsert', {
    // global_conversion_upsert.p_id is declared `uuid` (no `default
    // null`) but the body branches on `p_id is null` to choose
    // insert vs update. The typed surface forces non-null but the
    // runtime contract needs literal null. Sidestep via unknown — the
    // PR #19 nullability fix (`20260606000500_rpc_arg_nullability.sql`)
    // adds `default null` and lets this be `?? undefined` cleanly.
    p_id: (input.id ?? null) as unknown as string,
    p_from_unit: input.fromUnit,
    p_to_unit: input.toUnit,
    p_factor: input.factor,
    // Body coalesces empty-string → null, so '' is a safe sentinel.
    p_ingredient_name: input.ingredientName ?? '',
    p_notes: input.notes ?? '',
  });
  if (error) throw error;
  return data as string;
}

export async function deleteGlobalConversion(id: string): Promise<void> {
  const { error } = await supabase.rpc('global_conversion_delete', { p_id: id });
  if (error) throw error;
}

// ---------- DB row → domain rule mapper ----------
//
// Normalizes whatever the storage layer hands back into the
// ConversionRule shape the LayeredConversionRegistry expects.
// canonicalUnitName handles "whole" / "WHOLE" / "Piece" → "piece" so
// the catalog's enum and a freeform user entry resolve to the same
// token at lookup time.

export function toDomainRule(
  priority: ConversionRulePriority,
): (row: HouseConversionRule | GlobalConversionRule) => ConversionRule {
  return (row) =>
    conversionRule({
      fromUnit: canonicalUnitName(row.fromUnit),
      toUnit: canonicalUnitName(row.toUnit),
      factor: row.factor,
      ingredientName: row.ingredientName ?? undefined,
      priority,
    });
}
