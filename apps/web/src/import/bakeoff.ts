import { formatQuantity, type ParsedRecipeDraft } from '@cookyourbooks/domain';

/**
 * Render a draft into a short canonical text blob suitable for a textual
 * diff. We deliberately serialize only the user-visible fields (title,
 * yield, ingredient list, instruction text) so a diff doesn't flag noise
 * like model-minted ingredient ids that change every run.
 */
export function summarizeDraftForDiff(draft: ParsedRecipeDraft): string {
  const lines: string[] = [];
  lines.push(`Title: ${draft.title ?? '(none)'}`);
  if (draft.bookTitle) lines.push(`Book: ${draft.bookTitle}`);
  if (draft.pageNumbers && draft.pageNumbers.length > 0)
    lines.push(`Pages: ${draft.pageNumbers.join(', ')}`);
  if (draft.servings) {
    const s = draft.servings;
    const range =
      s.amountMax !== undefined ? `${s.amount}–${s.amountMax}` : `${s.amount}`;
    lines.push(`Yield: ${range} ${s.description ?? 'servings'}`);
  }
  if (draft.timeEstimate) lines.push(`Time: ${draft.timeEstimate}`);
  lines.push('');
  lines.push('Ingredients:');
  for (const ing of draft.ingredients) {
    if (ing.type === 'MEASURED') {
      lines.push(`  - ${formatQuantity(ing.quantity)} ${ing.name}`);
    } else {
      lines.push(`  - ${ing.name}${ing.description ? ` (${ing.description})` : ''}`);
    }
  }
  lines.push('');
  lines.push('Steps:');
  for (const step of draft.instructions) {
    lines.push(`  ${step.stepNumber}. ${step.text}`);
  }
  return lines.join('\n');
}

/** Per-line diff hunk used by the comparison view. */
export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/**
 * Tiny LCS-based line diff. The full diff library set in npm pulls a lot
 * of weight for this single view; an inline implementation is fine for
 * the relatively short draft summaries we feed it.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const m = aLines.length;
  const n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      out.push({ kind: 'same', text: aLines[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: aLines[i]! });
      i++;
    } else {
      out.push({ kind: 'add', text: bLines[j]! });
      j++;
    }
  }
  while (i < m) out.push({ kind: 'del', text: aLines[i++]! });
  while (j < n) out.push({ kind: 'add', text: bLines[j++]! });
  return out;
}
