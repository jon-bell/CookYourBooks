import { useEffect, useState } from 'react';
import type { OccasionCategory, Recipe, RecipeAdjustment } from '@cookyourbooks/domain';
import { todayISO } from './dateGrid.js';
import { OCCASION_OPTIONS } from './format.js';
import { AdjustmentsEditor } from './AdjustmentsEditor.js';

export type CookMode = 'made' | 'schedule';

const inputCls =
  'w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-3 py-2 text-sm';

/**
 * Modal for logging "I made this" or scheduling a future cook. Hand-rolled
 * overlay matching the app's dialog convention (no Radix); Escape closes.
 */
export function LogCookDialog({
  recipe,
  mode,
  initialDate,
  onSubmit,
  onClose,
  busy,
}: {
  recipe: Recipe;
  mode: CookMode;
  initialDate?: string;
  onSubmit: (input: {
    date: string;
    occasionCategory?: OccasionCategory;
    occasionNote?: string;
    notes?: string;
    adjustments?: RecipeAdjustment[];
    photos: File[];
  }) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const [date, setDate] = useState(initialDate ?? todayISO());
  const [occasionCategory, setOccasionCategory] = useState<OccasionCategory | ''>('');
  const [occasionNote, setOccasionNote] = useState('');
  const [notes, setNotes] = useState('');
  const [adjustments, setAdjustments] = useState<RecipeAdjustment[]>([]);
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Local object-URL previews for the selected (not-yet-uploaded) photos.
  useEffect(() => {
    const urls = photos.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [photos]);

  const title = mode === 'made' ? 'I made this' : 'Schedule a cook';

  function submit() {
    onSubmit({
      date,
      occasionCategory: occasionCategory || undefined,
      occasionNote: occasionNote.trim() || undefined,
      notes: notes.trim() || undefined,
      adjustments: adjustments.length > 0 ? adjustments : undefined,
      photos,
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-950/60 p-4"
      onClick={onClose}
    >
      <div
        className="mt-12 w-full max-w-lg rounded-lg border border-stone-200 bg-white p-5 shadow-xl dark:border-stone-700 dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
          >
            Close (esc)
          </button>
        </div>
        <p className="mt-0.5 text-sm text-stone-500">{recipe.title}</p>

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">
              {mode === 'made' ? 'When did you make it?' : 'When will you make it?'}
            </span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={`mt-1 ${inputCls}`}
              data-testid="cook-date"
            />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium">Occasion</span>
              <select
                value={occasionCategory}
                onChange={(e) => setOccasionCategory(e.target.value as OccasionCategory | '')}
                className={`mt-1 ${inputCls}`}
              >
                <option value="">— none —</option>
                {OCCASION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Occasion note</span>
              <input
                type="text"
                value={occasionNote}
                placeholder="e.g. Mum's birthday"
                onChange={(e) => setOccasionNote(e.target.value)}
                className={`mt-1 ${inputCls}`}
              />
            </label>
          </div>

          <label className="block">
            <span className="text-sm font-medium">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="How did it go?"
              className={`mt-1 ${inputCls}`}
              data-testid="cook-notes"
            />
          </label>

          <div>
            <label className="block">
              <span className="text-sm font-medium">Photos</span>
              <input
                type="file"
                accept="image/*"
                multiple
                capture="environment"
                onChange={(e) => {
                  // Append (so you can add in multiple goes); reset the
                  // input so re-picking the same file still fires onChange.
                  const picked = Array.from(e.target.files ?? []);
                  setPhotos((cur) => [...cur, ...picked]);
                  e.target.value = '';
                }}
                className="mt-1 block w-full text-sm text-stone-600 file:mr-3 file:rounded-md file:border-0 file:bg-stone-100 file:px-3 file:py-1.5 file:text-sm dark:file:bg-stone-800 dark:text-stone-300"
                data-testid="cook-photos"
              />
            </label>
            {previews.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2" data-testid="photo-previews">
                {previews.map((url, i) => (
                  <div key={url} className="relative" data-testid="photo-preview">
                    <img
                      src={url}
                      alt={`Selected photo ${i + 1}`}
                      className="h-16 w-16 rounded-md object-cover"
                    />
                    <button
                      type="button"
                      aria-label={`Remove photo ${i + 1}`}
                      onClick={() => setPhotos((cur) => cur.filter((_, idx) => idx !== i))}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-stone-900 text-xs text-white hover:bg-red-600 dark:bg-stone-200 dark:text-stone-900"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <details className="rounded-md border border-stone-200 dark:border-stone-700 p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Record what I changed (optional)
            </summary>
            <div className="mt-3">
              <AdjustmentsEditor recipe={recipe} value={adjustments} onChange={setAdjustments} />
            </div>
          </details>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !date}
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300"
            data-testid="cook-submit"
          >
            {mode === 'made' ? 'Save to history' : 'Schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
