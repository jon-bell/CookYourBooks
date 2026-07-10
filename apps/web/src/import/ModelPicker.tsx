import { useEffect, useState } from 'react';

import {
  formatSavedModel,
  listSavedOcrModels,
  type OcrProvider,
  type SavedOcrModel,
} from './api.js';

export interface ModelChoice {
  provider: OcrProvider;
  model: string;
  /** Named user_ocr_keys endpoint; null = 'default'. */
  endpoint: string | null;
}

/**
 * A compact dropdown of the user's saved models (Settings → Saved models) for
 * the OCR retry flows. The first option is always "the batch's configured
 * fallback" (a null choice — callers keep their existing bare-retry call);
 * picking a saved model returns its provider/endpoint/model triple, which the
 * caller writes onto the batch fallback via the retry RPC.
 *
 * Renders nothing while loading and collapses to nothing when the user has no
 * saved models — the surrounding retry UI must keep working without it.
 */
export function ModelPicker({
  value,
  onChange,
  fallbackLabel,
}: {
  value: ModelChoice | null;
  onChange: (choice: ModelChoice | null) => void;
  /** Label of the null option, e.g. 'Configured fallback (gpt-5.4)'. */
  fallbackLabel: string;
}) {
  const [models, setModels] = useState<SavedOcrModel[]>([]);
  useEffect(() => {
    let cancelled = false;
    listSavedOcrModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch(() => {
        // Online-only nicety: without the list the bare retry still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (models.length === 0) return null;

  const selectedIndex =
    value === null
      ? -1
      : models.findIndex(
          (m) =>
            m.provider === value.provider &&
            m.model === value.model &&
            (m.endpoint === (value.endpoint ?? 'default'))
        );

  return (
    <select
      aria-label="Retry model"
      value={selectedIndex}
      onChange={(e) => {
        const idx = Number(e.target.value);
        const m = models[idx];
        onChange(
          m
            ? {
                provider: m.provider,
                model: m.model,
                endpoint: m.endpoint === 'default' ? null : m.endpoint,
              }
            : null,
        );
      }}
      className="rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1.5 text-xs"
    >
      <option value={-1}>{fallbackLabel}</option>
      {models.map((m, i) => (
        <option key={m.id} value={i}>
          {formatSavedModel(m)}
        </option>
      ))}
    </select>
  );
}
