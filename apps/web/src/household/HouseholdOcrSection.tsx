import { useEffect, useState } from 'react';

import type { OcrProvider } from '../import/api.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../settings/ocrSettings.js';
import type { HouseholdMemberWithProfile } from './api.js';
import { useHouseholdOcrConfig, useSetHouseholdOcrConfig } from './queries.js';

/**
 * Owner-only control to share an OCR setup (provider/model/prompt/fallback +
 * one member's API key) with the whole household, so members who haven't set
 * up their own OCR can still run bulk imports. Members see a read-only badge.
 */
export function HouseholdOcrSection({
  householdId,
  householdName,
  isOwner,
  members,
}: {
  householdId: string;
  householdName: string;
  isOwner: boolean;
  members: HouseholdMemberWithProfile[];
}) {
  const { data: cfg } = useHouseholdOcrConfig();
  const setCfg = useSetHouseholdOcrConfig();
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState<OcrProvider>('gemini');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [fallbackProvider, setFallbackProvider] = useState<'' | OcrProvider>('');
  const [fallbackModel, setFallbackModel] = useState('');
  const [keyOwnerId, setKeyOwnerId] = useState('');

  // Seed the form from the saved config once it loads.
  useEffect(() => {
    if (!cfg) return;
    setProvider(cfg.provider);
    setModel(cfg.model);
    setPrompt(cfg.prompt ?? '');
    setFallbackProvider(cfg.fallback_provider ?? '');
    setFallbackModel(cfg.fallback_model ?? '');
    setKeyOwnerId(cfg.key_owner_id);
  }, [cfg]);

  const enabled = cfg?.ocr_share_enabled ?? false;
  const keyOwnerName =
    members.find((m) => m.user_id === cfg?.key_owner_id)?.display_name ?? 'a member';

  async function save(nextEnabled: boolean) {
    setError(null);
    try {
      await setCfg.mutateAsync({
        householdId,
        enabled: nextEnabled,
        provider,
        model: model.trim() || DEFAULT_MODEL_BY_PROVIDER[provider],
        prompt: prompt.trim() || null,
        fallbackProvider: fallbackProvider || null,
        fallbackModel: fallbackProvider ? fallbackModel.trim() || null : null,
        keyOwnerId: keyOwnerId || null,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Members (non-owner) get a read-only summary.
  if (!isOwner) {
    return (
      <div data-testid="household-ocr-section">
        <h2 className="text-lg font-semibold">Shared OCR</h2>
        <div className="mt-2 rounded-md border border-stone-200 dark:border-stone-700 px-3 py-3 text-sm text-stone-700 dark:text-stone-300">
          {enabled ? (
            <>
              <span className="rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700 px-2 py-0.5 text-xs text-emerald-900 dark:text-emerald-200">
                On
              </span>{' '}
              {householdName} shares OCR ({cfg?.provider} · {cfg?.model}) using {keyOwnerName}'s key
              — you can import without configuring your own.
            </>
          ) : (
            <>The household owner hasn't shared an OCR setup.</>
          )}
        </div>
      </div>
    );
  }

  const active = members.filter((m) => m.left_at === null);

  return (
    <div data-testid="household-ocr-section">
      <h2 className="text-lg font-semibold">Shared OCR</h2>
      <div className="mt-2 space-y-3 rounded-md border border-stone-200 dark:border-stone-700 px-3 py-3">
        <p className="text-sm text-stone-700 dark:text-stone-300">
          Share one OCR setup with everyone in <strong>{householdName}</strong>. Members who haven't
          added their own key import using the key owner's account.{' '}
          <span className="text-xs text-stone-500">Costs bill to the key owner's provider.</span>
        </p>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="space-y-1">
            <span className="text-stone-600 dark:text-stone-400">Provider</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as OcrProvider)}
              className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1"
              data-testid="household-ocr-provider"
            >
              <option value="gemini">Gemini</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-stone-600 dark:text-stone-400">Model</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={DEFAULT_MODEL_BY_PROVIDER[provider]}
              className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1"
              data-testid="household-ocr-model"
            />
          </label>
        </div>

        <label className="block space-y-1 text-sm">
          <span className="text-stone-600 dark:text-stone-400">Prompt (optional)</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="Leave blank to use the built-in recipe prompt."
            className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1"
          />
        </label>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="space-y-1">
            <span className="text-stone-600 dark:text-stone-400">Fallback provider</span>
            <select
              value={fallbackProvider}
              onChange={(e) => setFallbackProvider(e.target.value as '' | OcrProvider)}
              className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1"
            >
              <option value="">None</option>
              <option value="gemini">Gemini</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-stone-600 dark:text-stone-400">Fallback model</span>
            <input
              value={fallbackModel}
              onChange={(e) => setFallbackModel(e.target.value)}
              disabled={!fallbackProvider}
              className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 disabled:opacity-50"
            />
          </label>
        </div>

        <label className="block space-y-1 text-sm">
          <span className="text-stone-600 dark:text-stone-400">Whose key to use</span>
          <select
            value={keyOwnerId}
            onChange={(e) => setKeyOwnerId(e.target.value)}
            className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1"
            data-testid="household-ocr-keyowner"
          >
            <option value="">Me (the owner)</option>
            {active.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.display_name ?? m.user_id}
              </option>
            ))}
          </select>
        </label>

        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-sm">
            {enabled ? (
              <span className="rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700 px-2 py-0.5 text-xs text-emerald-900 dark:text-emerald-200">
                Sharing on
              </span>
            ) : (
              <span className="rounded-md bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-600 px-2 py-0.5 text-xs">
                Sharing off
              </span>
            )}
          </span>
          <div className="flex gap-2">
            {enabled && (
              <button
                onClick={() => void save(false)}
                disabled={setCfg.isPending}
                className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60"
              >
                Turn off
              </button>
            )}
            <button
              onClick={() => void save(true)}
              disabled={setCfg.isPending}
              data-testid="household-ocr-save"
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 disabled:opacity-60"
            >
              {setCfg.isPending ? 'Saving…' : enabled ? 'Save changes' : 'Share OCR'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
