import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createCookbook, type RecipeCollection } from '@cookyourbooks/domain';
import { useAuth } from '../auth/AuthProvider.js';
import { useCollectionPickerOptions, useSaveCollection } from '../data/queries.js';
import { useOcrKeys } from '../import/queries.js';
import { useSync } from '../local/SyncProvider.js';
import { uploadBatch, type UploadProgress } from '../import/uploadBatch.js';
import {
  loadFallbackPrefs,
  DEFAULT_FALLBACK_MODEL,
} from '../settings/FallbackModelSection.js';
import { loadOcrSettings, DEFAULT_MODEL_BY_PROVIDER } from '../settings/ocrSettings.js';
import {
  captureMultiShot,
  isMultiShotAvailable,
} from '../import/multiShotShim.js';
import { CookbookCombobox } from '../import/CookbookCombobox.js';

type Step = 'source' | 'review' | 'settings' | 'uploading';

export function ImportNewPage() {
  const { user } = useAuth();
  const { syncNow, status: syncStatus } = useSync();
  const navigate = useNavigate();
  const { data: pickerOptions = [], isLoading: pickerLoading } = useCollectionPickerOptions();
  const { data: ocrKeys = [] } = useOcrKeys();
  const saveCollection = useSaveCollection();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('source');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [name, setName] = useState(() => `Imported ${new Date().toLocaleDateString()}`);
  const [targetCollectionId, setTargetCollectionId] = useState<string>('');
  // 'ocr-first' = current behavior (worker OCRs each page, user merges
  // after). 'group-first' = user clicks splits between pages, then
  // each group OCRs as one call. Default stays 'ocr-first' so existing
  // flows are untouched.
  const [importMode, setImportMode] = useState<'ocr-first' | 'group-first'>('ocr-first');
  const [creatingCookbook, setCreatingCookbook] = useState(false);
  const [newCookbookTitle, setNewCookbookTitle] = useState('');
  const [newCookbookAuthor, setNewCookbookAuthor] = useState('');
  const [provider, setProvider] = useState<'gemini' | 'openai-compatible'>('gemini');
  const [model, setModel] = useState('');
  const [fallbackProvider, setFallbackProvider] = useState<
    '' | 'gemini' | 'openai-compatible'
  >(() => loadFallbackPrefs().provider);
  const [fallbackModel, setFallbackModel] = useState(() => loadFallbackPrefs().model);
  const [progress, setProgress] = useState<UploadProgress | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [multiShotReady, setMultiShotReady] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Seed defaults from the user's OCR settings, falling back to a sensible
  // provider/model if nothing's stored yet.
  useEffect(() => {
    const existing = loadOcrSettings();
    if (existing) {
      setProvider(existing.provider);
      setModel(existing.model);
    } else if (ocrKeys.length > 0) {
      const k = ocrKeys[0]!;
      const p = k.provider === 'openai-compatible' ? 'openai-compatible' : 'gemini';
      setProvider(p);
      setModel(DEFAULT_MODEL_BY_PROVIDER[p]);
    } else {
      setModel(DEFAULT_MODEL_BY_PROVIDER.gemini);
    }
    const fallback = loadFallbackPrefs();
    setFallbackProvider(fallback.provider);
    setFallbackModel(fallback.model);
  }, [ocrKeys]);

  useEffect(() => {
    void (async () => setMultiShotReady(await isMultiShotAvailable()))();
  }, []);

  // Generate object URL previews, revoking the old ones whenever the
  // file list changes.
  useEffect(() => {
    const urls = files.map((f) =>
      f.type === 'application/pdf' ? '' : URL.createObjectURL(f),
    );
    setPreviews(urls);
    return () => {
      for (const u of urls) if (u) URL.revokeObjectURL(u);
    };
  }, [files]);

  // Warn the user before navigation while an upload is in flight.
  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (step === 'uploading') {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [step]);

  const totalSizeMb = useMemo(
    () => (files.reduce((acc, f) => acc + f.size, 0) / 1_048_576).toFixed(1),
    [files],
  );

  const sourceKind = files.some(
    (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
  )
    ? 'PDF'
    : 'IMAGES';

  function addFiles(list: FileList | File[] | null | undefined) {
    if (!list) return;
    const arr = Array.from(list);
    if (arr.length === 0) return;
    setFiles((cur) => [...cur, ...arr]);
    setStep('review');
  }

  async function onTakePhotos() {
    try {
      const captured = await captureMultiShot();
      if (captured.length > 0) addFiles(captured);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  }

  async function onCreateCookbook() {
    const title = newCookbookTitle.trim();
    if (!title) return;
    const cookbook: RecipeCollection = createCookbook({
      title,
      author: newCookbookAuthor.trim() || undefined,
    });
    try {
      await saveCollection.mutateAsync(cookbook);
      setTargetCollectionId(cookbook.id);
      setCreatingCookbook(false);
      setNewCookbookTitle('');
      setNewCookbookAuthor('');
    } catch (e) {
      setError(`Could not create cookbook: ${(e as Error).message}`);
    }
  }

  async function startImport() {
    if (!user) return;
    if (files.length === 0) return;
    setError(undefined);
    setStep('uploading');
    try {
      const result = await uploadBatch(
        {
          ownerId: user.id,
          name: name.trim() || `Imported ${new Date().toLocaleDateString()}`,
          targetCollectionId: targetCollectionId || null,
          defaultProvider: provider,
          defaultModel: model.trim() || DEFAULT_MODEL_BY_PROVIDER[provider],
          fallbackProvider: fallbackProvider || null,
          fallbackModel: fallbackProvider
            ? fallbackModel.trim() || DEFAULT_FALLBACK_MODEL
            : null,
          sourceKind,
          files,
          awaitGrouping: importMode === 'group-first',
        },
        setProgress,
      );
      // Group-first lands on the grouping UI; ocr-first lands on the
      // usual batch board where OCR is already churning.
      await syncNow();
      navigate(
        importMode === 'group-first'
          ? `/import/${result.batchId}/group`
          : `/import/${result.batchId}`,
      );
    } catch (e) {
      setError((e as Error).message);
      setStep('settings');
    }
  }

  if (step === 'uploading') {
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
          Don't close this tab. Large batches take a few minutes.
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
          {progress?.message && (
            <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">{progress.message}</div>
          )}
          {progress?.phase === 'finalizing' && syncStatus === 'syncing' && (
            <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Saving batch locally while your library syncs in the background…
            </div>
          )}
        </div>
        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">New import batch</h1>

      {step === 'source' && (
        <section className="space-y-4">
          <div
            onDragEnter={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`rounded-lg border-2 border-dashed p-8 text-center transition ${
              dragOver
                ? 'border-stone-900 bg-stone-50'
                : 'border-stone-300 bg-white hover:bg-stone-50'
            }`}
          >
            <p className="text-sm text-stone-700 dark:text-stone-300">Drag & drop images or a PDF here</p>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">…or pick a source below</p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SourceButton
              label="Choose images"
              onClick={() => fileInputRef.current?.click()}
            />
            <SourceButton
              label="Upload PDF"
              onClick={() => pdfInputRef.current?.click()}
            />
            {multiShotReady && (
              <SourceButton label="Take photos" onClick={onTakePhotos} />
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={pdfInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        </section>
      )}

      {(step === 'review' || step === 'settings') && (
        <section
          onDragEnter={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`space-y-4 rounded-lg transition ${
            dragOver ? 'bg-stone-50 ring-2 ring-stone-900' : ''
          }`}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              {files.length} {files.length === 1 ? 'file' : 'files'} · {totalSizeMb} MB
            </h2>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
              >
                + Add more
              </button>
              <button
                type="button"
                onClick={() => {
                  setFiles([]);
                  setStep('source');
                }}
                className="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
              >
                Clear
              </button>
            </div>
          </div>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Drop more files anywhere on this panel to add them.
          </p>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="relative aspect-square overflow-hidden rounded-md border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-900"
              >
                {previews[i] ? (
                  <img
                    src={previews[i]}
                    alt={f.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-stone-500 dark:text-stone-400">
                    PDF
                  </div>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() =>
                    setFiles((cur) => cur.filter((_, idx) => idx !== i))
                  }
                  className="absolute right-1 top-1 rounded-full bg-white/90 px-1.5 text-xs leading-tight text-stone-700 dark:text-stone-300 shadow"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          <fieldset className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-3">
            <legend className="px-1 text-sm font-medium text-stone-700 dark:text-stone-300">
              When do you want to group multi-page recipes?
            </legend>
            <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <ModeOption
                checked={importMode === 'ocr-first'}
                onChange={() => setImportMode('ocr-first')}
                title="OCR each page, then merge"
                body="Worker reads every page individually. Use this when each page is its own recipe, or you're not sure yet — you can still merge pages later from the batch board."
              />
              <ModeOption
                checked={importMode === 'group-first'}
                onChange={() => setImportMode('group-first')}
                title="Group pages first, then OCR"
                body="You drop splits between pages so the worker reads each group as one recipe. One OCR call per recipe instead of per page — cheaper, and avoids mid-recipe page breaks confusing the model."
              />
            </div>
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Batch name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Target cookbook">
              {creatingCookbook ? (
                <div className="space-y-2 rounded border border-stone-300 dark:border-stone-600 bg-stone-50 dark:bg-stone-900 p-2">
                  <input
                    autoFocus
                    placeholder="Cookbook title"
                    value={newCookbookTitle}
                    onChange={(e) => setNewCookbookTitle(e.target.value)}
                    className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm"
                  />
                  <input
                    placeholder="Author (optional)"
                    value={newCookbookAuthor}
                    onChange={(e) => setNewCookbookAuthor(e.target.value)}
                    className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={onCreateCookbook}
                      disabled={!newCookbookTitle.trim() || saveCollection.isPending}
                      className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1 text-xs font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
                    >
                      {saveCollection.isPending ? 'Creating…' : 'Create'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCreatingCookbook(false);
                        setNewCookbookTitle('');
                        setNewCookbookAuthor('');
                      }}
                      className="rounded-md px-3 py-1 text-xs text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <CookbookCombobox
                    options={pickerOptions}
                    value={targetCollectionId}
                    onChange={setTargetCollectionId}
                    onCreateNew={() => setCreatingCookbook(true)}
                    loading={pickerLoading}
                  />
                  {!pickerLoading && pickerOptions.length === 0 && (
                    <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                      No cookbooks yet — pick "Create new cookbook" above or leave unassigned.
                    </p>
                  )}
                </>
              )}
            </Field>
            <Field label="Default provider">
              <select
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as 'gemini' | 'openai-compatible';
                  setProvider(p);
                  if (!model) setModel(DEFAULT_MODEL_BY_PROVIDER[p]);
                }}
                className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 text-sm"
              >
                <option value="gemini">Google Gemini</option>
                <option value="openai-compatible">OpenAI-compatible</option>
              </select>
            </Field>
            <Field label="Default model">
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 font-mono text-sm"
              />
            </Field>
            <Field label="Fallback provider (optional)">
              <select
                value={fallbackProvider}
                onChange={(e) =>
                  setFallbackProvider(
                    e.target.value as '' | 'gemini' | 'openai-compatible',
                  )
                }
                className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 text-sm"
              >
                <option value="">(none)</option>
                <option value="gemini">Google Gemini</option>
                <option value="openai-compatible">OpenAI-compatible</option>
              </select>
            </Field>
            {fallbackProvider && (
              <Field label="Fallback model">
                <input
                  value={fallbackModel}
                  onChange={(e) => setFallbackModel(e.target.value)}
                  placeholder={DEFAULT_MODEL_BY_PROVIDER[fallbackProvider]}
                  className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 font-mono text-sm"
                />
              </Field>
            )}
          </div>

          {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={startImport}
              disabled={files.length === 0}
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
            >
              Start import
            </button>
            <button
              type="button"
              onClick={() => navigate('/import')}
              className="rounded-md px-4 py-2 text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
            >
              Cancel
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function SourceButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-3 text-sm font-medium hover:bg-stone-50 dark:hover:bg-stone-900 hover:border-stone-400"
    >
      {label}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-300">{label}</span>
      {children}
    </label>
  );
}

function ModeOption({
  checked,
  onChange,
  title,
  body,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  body: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm ${
        checked
          ? 'border-stone-900 bg-stone-50'
          : 'border-stone-200 hover:border-stone-400'
      }`}
    >
      <input
        type="radio"
        name="import-mode"
        checked={checked}
        onChange={onChange}
        className="mt-1"
      />
      <span>
        <span className="block font-medium text-stone-900 dark:text-stone-100">{title}</span>
        <span className="mt-1 block text-xs text-stone-600 dark:text-stone-400">{body}</span>
      </span>
    </label>
  );
}
