import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Dark-mode guard. The app has no design-token layer — it styles with Tailwind
 * `stone-*` utilities plus explicit `dark:` variants (see CLAUDE.md). A base
 * light utility with no `dark:` counterpart renders as a bright box / invisible
 * text in dark mode. This test scans every `className` attribute and fails if a
 * high-signal light utility appears without a dark counterpart *in the same
 * attribute*, so the whole class of "forgot the dark: variant" bug can't creep
 * back in. Intentional exceptions (overlays layered on media, the camera
 * shutter) go in ALLOWLIST with a reason.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...walk(p));
    } else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) {
      out.push(p);
    }
  }
  return out;
}

interface Attr {
  text: string;
  index: number;
}

/** Extract the raw text of every `className={...}` / `className="..."` value. */
function classNameAttrs(src: string): Attr[] {
  const attrs: Attr[] = [];
  const re = /className\s*=\s*/g;
  while (re.exec(src) !== null) {
    const i = re.lastIndex;
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) break;
      attrs.push({ text: src.slice(i + 1, end), index: i + 1 });
      re.lastIndex = end + 1;
    } else if (ch === '{') {
      // Balance braces so template literals with `${...}` are captured whole
      // (both branches of a `cond ? 'a' : 'b'` ternary end up in `text`).
      let depth = 0;
      let j = i;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) {
          j++;
          break;
        }
      }
      attrs.push({ text: src.slice(i + 1, j - 1), index: i + 1 });
      re.lastIndex = j;
    }
  }
  return attrs;
}

/** Attribute substrings that are intentionally light-only, with a reason. */
const ALLOWLIST: { file: string; needle: string; why: string }[] = [
  {
    file: 'components/RecipeScanDialog.tsx',
    needle: 'border-stone-800 px-3 py-2 text-xs text-stone-400',
    why: 'Caption bar of the original-scan lightbox, which is unconditionally dark (the dialog root is `fixed inset-0 … bg-stone-950/90`).',
  },
  {
    file: 'import/ScannerHelpModal.tsx',
    needle: 'rounded p-1 text-stone-400',
    why: 'Close button of the scanner tutorial, which is unconditionally dark to match the camera chrome (modal root is `bg-stone-900`).',
  },
  {
    file: 'import/ScannerHelpModal.tsx',
    needle: 'mt-4 text-xs text-stone-400',
    why: 'Footnote of the scanner tutorial — same unconditionally-dark surface.',
  },
  {
    file: 'import/CameraScanner.tsx',
    needle: 'bg-white px-4 py-2 font-medium text-stone-950',
    why: '"Use the system camera" fallback button layered over the (dark) camera surface — a white chip on video, correct in both themes.',
  },
  {
    file: 'import/CameraScanner.tsx',
    needle: 'border-white bg-white/90 shadow-lg',
    why: 'Camera shutter button over the live video feed — always a white circle on a dark surface.',
  },
  {
    file: 'pages/ImportGroupingPage.tsx',
    needle: 'h-full items-center justify-center text-sm text-stone-400',
    why: 'Loading text inside the fullscreen page-preview overlay, which is layered on a `bg-stone-900/95` backdrop (dark).',
  },
  {
    file: 'pages/ImportGroupingPage.tsx',
    needle: 'bg-white/10 px-2 py-0.5',
    why: 'Translucent-white "Recipe N of M" chip inside the dark fullscreen page-preview overlay.',
  },
  {
    file: 'pages/ImportGroupingPage.tsx',
    needle: 'bg-white/90 px-3 py-1.5 font-medium text-stone-900',
    why: 'Close button inside the dark fullscreen page-preview overlay — white chip on a `bg-stone-900/95` backdrop.',
  },
];

const RULES = [
  {
    name: 'missing dark: background',
    // Unprefixed white / near-white container backgrounds.
    offends: (t: string) => /^bg-white(\/\d{1,3})?$/.test(t) || /^bg-stone-(50|100)$/.test(t),
    satisfiedBy: (t: string) => /^dark:(?:[\w-]+:)*bg-/.test(t),
  },
  {
    name: 'missing dark: text color',
    offends: (t: string) => t === 'text-stone-400',
    satisfiedBy: (t: string) => /^dark:(?:[\w-]+:)*text-/.test(t),
  },
  {
    name: 'missing dark: border color',
    offends: (t: string) => t === 'border-stone-200' || t === 'border-stone-300',
    satisfiedBy: (t: string) => /^dark:(?:[\w-]+:)*border-/.test(t),
  },
] as const;

describe('dark-mode variants', () => {
  it('every className with a base light utility carries a dark: counterpart', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      const rel = file.slice(SRC.length);
      for (const attr of classNameAttrs(src)) {
        const tokens = attr.text.match(/[\w:/\-[\].%]+/g) ?? [];
        for (const rule of RULES) {
          if (!tokens.some(rule.offends)) continue;
          if (tokens.some(rule.satisfiedBy)) continue;
          if (ALLOWLIST.some((a) => rel.includes(a.file) && attr.text.includes(a.needle))) continue;
          const line = src.slice(0, attr.index).split('\n').length;
          offenders.push(`${rel}:${line} — ${rule.name}: ${attr.text.replace(/\s+/g, ' ').trim()}`);
        }
      }
    }
    expect(offenders, `\n${offenders.join('\n')}\n`).toEqual([]);
  });
});
