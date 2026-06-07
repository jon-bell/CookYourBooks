import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { useSync } from '../local/SyncProvider.js';
import { useCollectionPickerOptions } from '../data/queries.js';
import { uploadBatch, type UploadProgress } from '../import/uploadBatch.js';
import { getEffectiveOcrConfig } from '../import/api.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../settings/ocrSettings.js';
import { resolveImportFallback } from '../settings/FallbackModelSection.js';
import { CookbookCombobox } from '../import/CookbookCombobox.js';
import { OcrSetupGuide } from '../import/OcrSetupGuide.js';
import { scanPages } from '../import/scanPages.js';

type Phase = 'config' | 'scanning' | 'uploading';

/**
 * Mobile-first "Scan pages" entry: pick an optional target cookbook, then
 * rapid-capture pages with the live viewfinder ({@link scanPages}) and feed
 * them straight into the standard OCR pipeline ({@link uploadBatch}). No
 * pre-starring of placeholder recipes required (unlike the Speed Importer),
 * and the OCR provider/model are resolved silently so there's no config form
 * on the phone.
 */
export function ScanPagesPage() {
  const { user } = useAuth();
  const { syncNow } = useSync();
  const navigate = useNavigate();
  const { data: pickerOptions = [], isLoading: pickerLoading } = useCollectionPickerOptions();
  const [targetCollectionId, setTargetCollectionId] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [phase, setPhase] = useState<Phase>('config');
  const [progress, setProgress] = useState<UploadProgress | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Resolve OCR config silently — the user configures nothing here. A null
  // result means no own key and no household share, so surface the guide.
  useEffect(() => {
    let cancelled = false;
    void getEffectiveOcrConfig()
      .then((cfg) => {
        if (!cancelled) setNeedsSetup(cfg === null);
      })
      .catch(() => {
        if (!cancelled) setNeedsSetup(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onScan() {
    if (!user) return;
    setError(undefined);
    setPhase('scanning');
    let files: File[] = [];
    try {
      files = await scanPages({ maxShots: 200 });
    } catch (e) {
      setError((e as Error).message);
      setPhase('config');
      return;
    }
    if (files.length === 0) {
      setPhase('config');
      return;
    }
    await upload(files);
  }

  async function upload(files: File[]) {
    if (!user) return;
    setPhase('uploading');
    setError(undefined);
    try {
      // Mirror ImportFromPhoto: own prefs+key, else the household's shared
      // config (which carries its own fallback), else gemini defaults.
      const cfg = await getEffectiveOcrConfig().catch(() => null);
      const localFallback = resolveImportFallback();
      const fallbackProvider =
        cfg?.source === 'household' ? cfg.fallbackProvider : localFallback.fallbackProvider;
      const fallbackModel =
        cfg?.source === 'household' ? cfg.fallbackModel : localFallback.fallbackModel;
      const defaultProvider = cfg?.provider ?? 'gemini';
      const { batchId } = await uploadBatch(
        {
          ownerId: user.id,
          name: `Scan ${new Date().toLocaleString()}`,
          targetCollectionId: targetCollectionId || null,
          defaultProvider,
          defaultModel: cfg?.model || DEFAULT_MODEL_BY_PROVIDER[defaultProvider],
          defaultPrompt: cfg?.prompt ?? null,
          fallbackProvider,
          fallbackModel,
          keyOwnerId: cfg?.source === 'household' ? cfg.keyOwnerId : null,
          sourceKind: 'IMAGES',
          files,
        },
        setProgress,
      );
      await syncNow();
      navigate(`/import/${batchId}`);
    } catch (e) {
      setError((e as Error).message);
      setPhase('config');
    }
  }

  if (phase === 'uploading') {
    const phaseLabel =
      progress?.phase === 'preparing'
        ? 'Preparing pages'
        : progress?.phase === 'uploading'
          ? 'Uploading'
          : progress?.phase === 'finalizing'
            ? 'Finalizing'
            : 'Done';
    const pct =
      progress && progress.total > 0
        ? Math.min(100, Math.round((progress.done / progress.total) * 100))
        : 0;
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Uploading…</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Don't close this tab — we're uploading your scanned pages.
        </p>
        <div>
          <div className="flex justify-between text-sm text-stone-700 dark:text-stone-300">
            <span>{phaseLabel}</span>
            <span>
              {progress?.done ?? 0} / {progress?.total ?? 0}
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
            <div className="h-full bg-stone-900 dark:bg-stone-100" style={{ width: `${pct}%` }} />
          </div>
        </div>
        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Scan pages</h1>
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Point your camera at a cookbook and tap the shutter for each page — no need to stop between
        shots. When you're done, we'll OCR every page into recipes.
      </p>

      {needsSetup && <OcrSetupGuide />}

      <div className="max-w-md space-y-1">
        <span className="block text-sm font-medium text-stone-700 dark:text-stone-300">
          Target cookbook (optional)
        </span>
        <CookbookCombobox
          options={pickerOptions}
          value={targetCollectionId}
          onChange={setTargetCollectionId}
          loading={pickerLoading}
        />
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Leave unassigned to sort pages into cookbooks later.
        </p>
      </div>

      <button
        type="button"
        onClick={onScan}
        disabled={phase === 'scanning'}
        className="inline-flex items-center gap-2 rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
      >
        <span aria-hidden>📷</span>
        {phase === 'scanning' ? 'Opening camera…' : 'Scan pages'}
      </button>

      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
