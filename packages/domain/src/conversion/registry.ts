import type { ConversionRule, ConversionRulePriority } from './rules.js';
import { StandardConversions } from './standard.js';

const PRIORITY_ORDER: ConversionRulePriority[] = ['HOUSE', 'RECIPE', 'STANDARD'];

function priorityRank(p: ConversionRulePriority): number {
  return PRIORITY_ORDER.indexOf(p);
}

export interface ConversionRegistry {
  readonly rules: readonly ConversionRule[];
  withRule(rule: ConversionRule): ConversionRegistry;
  findFactor(fromUnit: string, toUnit: string, ingredientName?: string): number | undefined;
}

class LayeredConversionRegistry implements ConversionRegistry {
  constructor(public readonly rules: readonly ConversionRule[]) {}

  withRule(rule: ConversionRule): ConversionRegistry {
    return new LayeredConversionRegistry([rule, ...this.rules]);
  }

  findFactor(fromUnit: string, toUnit: string, ingredientName?: string): number | undefined {
    if (fromUnit === toUnit) return 1;
    const direct = this.findDirect(fromUnit, toUnit, ingredientName);
    if (direct !== undefined) return direct;
    // One-hop search through intermediate units.
    const intermediates = new Set<string>();
    for (const r of this.rules) {
      if (r.fromUnit === fromUnit && this.ingredientMatches(r, ingredientName)) {
        intermediates.add(r.toUnit);
      }
    }
    let best: { rank: number; factor: number } | undefined;
    for (const mid of intermediates) {
      const a = this.findDirect(fromUnit, mid, ingredientName);
      const b = this.findDirect(mid, toUnit, ingredientName);
      if (a !== undefined && b !== undefined) {
        // For one-hop, we lose rule priority tracking, treat as STANDARD hop.
        const rank = priorityRank('STANDARD');
        if (!best || rank < best.rank) best = { rank, factor: a * b };
      }
    }
    return best?.factor;
  }

  private ingredientMatches(rule: ConversionRule, ingredientName?: string): boolean {
    if (!rule.ingredientName) return true; // generic rule always matches
    if (!ingredientName) return false;
    return rule.ingredientName.toLowerCase() === ingredientName.toLowerCase();
  }

  private findDirect(from: string, to: string, ingredientName?: string): number | undefined {
    let best: { rank: number; factor: number; specific: boolean } | undefined;
    for (const r of this.rules) {
      if (r.fromUnit !== from || r.toUnit !== to) continue;
      if (!this.ingredientMatches(r, ingredientName)) continue;
      const rank = priorityRank(r.priority);
      const specific = !!r.ingredientName;
      if (
        !best ||
        rank < best.rank ||
        // same priority: ingredient-specific beats generic
        (rank === best.rank && specific && !best.specific)
      ) {
        best = { rank, factor: r.factor, specific };
      }
    }
    return best?.factor;
  }
}

export function createRegistry(rules: readonly ConversionRule[] = StandardConversions): ConversionRegistry {
  return new LayeredConversionRegistry(rules);
}
