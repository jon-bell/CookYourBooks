import { useState } from 'react';

import {
  DEFAULT_VARIANTS,
  loadBakeoffVariants,
  type LocalBakeoffVariant,
  newVariant,
  saveBakeoffVariants,
} from '../settings/bakeoffSettings.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../settings/ocrSettings.js';
import type { OcrProvider } from './model.js';

/** Editable variant matrix for bakeoff import batches. */
export function BakeoffVariantEditor({
  variants,
  onChange,
}: {
  variants: LocalBakeoffVariant[];
  onChange: (next: LocalBakeoffVariant[]) => void;
}) {
  function patchVariant(id: string, patch: Partial<LocalBakeoffVariant>) {
    onChange(
      variants.map((v) => {
        if (v.id !== id) return v;
        const next = { ...v, ...patch };
        if (patch.provider && patch.provider !== v.provider) {
          if (v.model === DEFAULT_MODEL_BY_PROVIDER[v.provider]) {
            next.model = DEFAULT_MODEL_BY_PROVIDER[patch.provider];
          }
        }
        return next;
      }),
    );
  }

  return (
    <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-700 dark:bg-stone-900">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">OCR variants</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChange([...variants, newVariant()])}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100"
          >
            + Add variant
          </button>
          <button
            type="button"
            onClick={() => {
              if (!confirm('Reset the variant list to defaults?')) return;
              onChange(DEFAULT_VARIANTS.map((v) => ({ ...v, id: crypto.randomUUID() })));
            }}
            className="rounded-md px-2 py-1 text-xs text-stone-600 hover:bg-stone-100"
          >
            Reset
          </button>
        </div>
      </div>
      <ul className="space-y-3" data-testid="bakeoff-variants">
        {variants.map((v, i) => (
          <VariantRow
            key={v.id}
            variant={v}
            index={i}
            canDelete={variants.length > 1}
            onChange={(patch) => patchVariant(v.id, patch)}
            onDelete={() =>
              onChange(variants.length <= 1 ? variants : variants.filter((x) => x.id !== v.id))
            }
          />
        ))}
      </ul>
    </section>
  );
}

export function useBakeoffVariantState(): [
  LocalBakeoffVariant[],
  (next: LocalBakeoffVariant[]) => void,
] {
  const [variants, setVariants] = useState<LocalBakeoffVariant[]>(() => loadBakeoffVariants());
  function update(next: LocalBakeoffVariant[]) {
    setVariants(next);
    saveBakeoffVariants(next);
  }
  return [variants, update];
}

function VariantRow({
  variant,
  index,
  canDelete,
  onChange,
  onDelete,
}: {
  variant: LocalBakeoffVariant;
  index: number;
  canDelete: boolean;
  onChange: (patch: Partial<LocalBakeoffVariant>) => void;
  onDelete: () => void;
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <li
      data-testid="bakeoff-variant"
      data-variant-id={variant.id}
      className="rounded-md border border-stone-200 p-3 space-y-2 dark:border-stone-700"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <label className="text-xs text-stone-600">
          Variant {index + 1} name
          <input
            type="text"
            value={variant.name}
            aria-label={`Variant ${index + 1} name`}
            onChange={(e) => onChange({ name: e.target.value })}
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1 text-sm dark:border-stone-600 dark:bg-stone-900"
          />
        </label>
        <label className="text-xs text-stone-600">
          Provider
          <select
            value={variant.provider}
            aria-label={`Variant ${index + 1} provider`}
            onChange={(e) => onChange({ provider: e.target.value as OcrProvider })}
            className="mt-1 block rounded border border-stone-300 px-2 py-1 text-sm dark:border-stone-600 dark:bg-stone-900"
          >
            <option value="gemini">Gemini</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>
        <button
          type="button"
          onClick={onDelete}
          disabled={!canDelete}
          className="rounded-md px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-30"
        >
          Remove
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs text-stone-600">
          Model
          <input
            type="text"
            value={variant.model}
            aria-label={`Variant ${index + 1} model`}
            onChange={(e) => onChange({ model: e.target.value })}
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1 font-mono text-xs dark:border-stone-600 dark:bg-stone-900"
          />
        </label>
        {variant.provider === 'openai-compatible' && (
          <label className="text-xs text-stone-600">
            Base URL
            <input
              type="text"
              value={variant.baseUrl ?? ''}
              aria-label={`Variant ${index + 1} base URL`}
              onChange={(e) => onChange({ baseUrl: e.target.value || undefined })}
              placeholder="https://api.openai.com/v1"
              className="mt-1 w-full rounded border border-stone-300 px-2 py-1 font-mono text-xs dark:border-stone-600 dark:bg-stone-900"
            />
          </label>
        )}
      </div>
      <details
        open={showPrompt}
        onToggle={(e) => setShowPrompt((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-xs text-stone-600">
          Prompt ({variant.prompt.length.toLocaleString()} chars)
        </summary>
        <textarea
          value={variant.prompt}
          aria-label={`Variant ${index + 1} prompt`}
          onChange={(e) => onChange({ prompt: e.target.value })}
          rows={6}
          className="mt-1 w-full rounded border border-stone-300 p-2 font-mono text-xs dark:border-stone-600 dark:bg-stone-900"
        />
      </details>
    </li>
  );
}
