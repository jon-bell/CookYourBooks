import { servings, type Servings } from '../model/servings.js';
import type { Ingredient } from '../model/ingredient.js';
import { instruction, type Instruction } from '../model/instruction.js';
import { parseIngredientLine } from './parseIngredient.js';

export interface ParsedRecipeDraft {
  title?: string;
  servings?: Servings;
  ingredients: Ingredient[];
  instructions: Instruction[];
  /** Lines we couldn't place. Shown to the user for manual review. */
  leftover: string[];
  // Rich OCR metadata — all optional, plain-text parse fills none of
  // these but the vision-model path (apps/web/src/import/llm.ts) does.
  description?: string;
  timeEstimate?: string;
  equipment?: string[];
  bookTitle?: string;
  pageNumbers?: number[];
  sourceImageText?: string;
}

const INGREDIENT_HEADINGS = [
  'ingredients',
  'you will need',
  "you'll need",
  'you will need:',
  'shopping list',
];

const INSTRUCTION_HEADINGS = [
  'instructions',
  'directions',
  'method',
  'preparation',
  'steps',
  'how to make',
  'procedure',
];

const SERVINGS_REGEX =
  /\b(?:serves|servings?|yields?|makes|serving size)\s*:?\s*(?:about\s+)?(\d+(?:\s*(?:-|–|to)\s*\d+)?)\s*([a-zA-Z][\w\s]{0,20})?/i;

/**
 * Turn a blob of OCR / pasted text into a best-effort recipe draft.
 *
 * Strategy:
 * 1. Split into non-empty lines.
 * 2. The first non-empty line that isn't a known heading is the title.
 * 3. Everything between an "Ingredients"-style heading and an
 *    "Instructions"-style heading becomes ingredient candidates, fed through
 *    {@link parseIngredientLine}.
 * 4. Lines under an "Instructions"-style heading become steps (numbered
 *    prefixes like `1.` / `Step 1:` are stripped).
 * 5. `Serves N` / `Yields N` anywhere near the title sets servings.
 * 6. Anything we can't place lands in `leftover` so the UI can surface it.
 */
export function parseRecipeText(raw: string): ParsedRecipeDraft {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let title: string | undefined;
  const ingredients: Ingredient[] = [];
  const instructions: Instruction[] = [];
  const leftover: string[] = [];
  let servingsOut: Servings | undefined;

  type Section = 'preamble' | 'ingredients' | 'instructions' | 'other';
  let section: Section = 'preamble';
  let stepNumber = 0;

  for (const line of lines) {
    const heading = classifyHeading(line);
    if (heading) {
      section = heading;
      continue;
    }

    // Servings can appear anywhere up top.
    if (!servingsOut) {
      const s = extractServings(line);
      if (s) {
        servingsOut = s;
        continue;
      }
    }

    switch (section) {
      case 'preamble': {
        if (!title) title = line;
        else leftover.push(line);
        break;
      }
      case 'ingredients': {
        const parsed = parseIngredientLine(stripListBullet(line));
        if (parsed) ingredients.push(parsed);
        else leftover.push(line);
        break;
      }
      case 'instructions': {
        stepNumber += 1;
        instructions.push(
          instruction({
            stepNumber,
            text: stripStepNumber(line),
          }),
        );
        break;
      }
      case 'other':
        leftover.push(line);
        break;
    }
  }

  // Heuristic fallback when no headings were present: treat single-line
  // entries as ingredients up until we hit something that looks like a
  // multi-sentence step.
  if (ingredients.length === 0 && instructions.length === 0 && lines.length > 1) {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (looksLikeStep(line)) {
        stepNumber += 1;
        instructions.push(instruction({ stepNumber, text: stripStepNumber(line) }));
      } else {
        const parsed = parseIngredientLine(stripListBullet(line));
        if (parsed) ingredients.push(parsed);
        else leftover.push(line);
      }
    }
  }

  return {
    title,
    servings: servingsOut,
    ingredients,
    instructions,
    leftover,
  };
}

function classifyHeading(line: string): 'ingredients' | 'instructions' | 'other' | undefined {
  const clean = line.toLowerCase().replace(/[:.\s]+$/g, '').trim();
  if (INGREDIENT_HEADINGS.includes(clean)) return 'ingredients';
  if (INSTRUCTION_HEADINGS.includes(clean)) return 'instructions';
  // Markdown-style `## Ingredients`
  const stripped = clean.replace(/^#+\s*/, '');
  if (INGREDIENT_HEADINGS.includes(stripped)) return 'ingredients';
  if (INSTRUCTION_HEADINGS.includes(stripped)) return 'instructions';
  return undefined;
}

function extractServings(line: string): Servings | undefined {
  const m = SERVINGS_REGEX.exec(line);
  if (!m) return undefined;
  const numMatch = /(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/.exec(m[1] ?? '');
  if (!numMatch) return undefined;
  const lo = Number(numMatch[1]);
  const hi = numMatch[2] ? Number(numMatch[2]) : undefined;
  if (!Number.isFinite(lo)) return undefined;
  const amount = hi && Number.isFinite(hi) ? Math.round((lo + hi) / 2) : lo;
  if (amount <= 0) return undefined;
  const desc = (m[2] ?? '').trim();
  return servings(amount, desc || undefined);
}

function stripListBullet(line: string): string {
  return line.replace(/^[-*•·]\s+/, '').trim();
}

function stripStepNumber(line: string): string {
  return line
    .replace(/^(?:step\s*)?\d+\s*[.):-]\s*/i, '')
    .trim();
}

function looksLikeStep(line: string): boolean {
  // Explicit "Step N" / numbered prefixes are always steps.
  if (/^(?:step\s*)?\d+\s*[.):-]/i.test(line)) return true;
  // Sentences (start with uppercase, end with terminal punctuation) that
  // don't start with a number are steps — ingredient lines almost always
  // lead with a quantity.
  const endsLikeSentence = /[.!?]$/.test(line);
  const startsWithNumber = /^\d/.test(line);
  if (endsLikeSentence && !startsWithNumber) return true;
  const words = line.split(/\s+/).length;
  return line.length > 60 || words > 8;
}
