import type { OccasionCategory, RecipeAdjustment } from '@cookyourbooks/domain';
import { parseISODate } from './dateGrid.js';

export const OCCASION_OPTIONS: { value: OccasionCategory; label: string }[] = [
  { value: 'MEAL', label: 'Meal' },
  { value: 'CELEBRATION', label: 'Celebration' },
  { value: 'MEAL_PREP', label: 'Meal prep' },
  { value: 'PRACTICE', label: 'Practice run' },
  { value: 'OTHER', label: 'Other' },
];

export function occasionLabel(category?: OccasionCategory): string {
  if (!category) return '';
  return OCCASION_OPTIONS.find((o) => o.value === category)?.label ?? category;
}

/** Human, locale-aware long date for a 'YYYY-MM-DD' string. */
export function formatEventDate(iso: string): string {
  return parseISODate(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Short "viewed 2h ago" style relative time for a ms timestamp. */
export function relativeTime(ms: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

/** One-line, human-readable summary of a single structured adjustment. */
export function summarizeAdjustment(a: RecipeAdjustment): string {
  switch (a.type) {
    case 'INGREDIENT_SWAP':
      return `Swapped ${a.fromName} → ${a.toText}`;
    case 'INGREDIENT_OMIT':
      return `Left out ${a.fromName}`;
    case 'INGREDIENT_ADD':
      return `Added ${a.toText}`;
    case 'INSTRUCTION_SWAP':
      return `Step ${a.stepNumber}: did "${a.toText}" instead`;
    case 'INSTRUCTION_SKIP':
      return `Skipped step ${a.stepNumber}`;
  }
}
