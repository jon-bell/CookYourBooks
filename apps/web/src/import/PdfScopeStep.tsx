import { useState } from 'react';

/** What a PDF should become. */
export type PdfScope = 'one' | 'split';

/**
 * A PDF is ambiguous: a printed web recipe is ONE recipe spread over a few
 * pages, while a scanned cookbook is one recipe PER page. The app used to
 * guess differently depending on which door you came through — shared PDFs
 * became one recipe, uploaded PDFs were split — so the same file produced
 * different libraries. Ask instead, once, in one place.
 */
export function defaultScopeForPageCount(pageCount: number): PdfScope {
  return pageCount <= SINGLE_RECIPE_MAX_PAGES ? 'one' : 'split';
}

/** At or below this, a PDF is far more likely to be one printed recipe. */
export const SINGLE_RECIPE_MAX_PAGES = 3;

export interface PdfScopeStepProps {
  pageCount: number;
  /** Shown above the choice, e.g. the file name. */
  fileName?: string;
  onConfirm: (scope: PdfScope) => void;
  onCancel: () => void;
}

export function PdfScopeStep({ pageCount, fileName, onConfirm, onCancel }: PdfScopeStepProps) {
  const [scope, setScope] = useState<PdfScope>(() => defaultScopeForPageCount(pageCount));
  const pages = `${pageCount} page${pageCount === 1 ? '' : 's'}`;

  return (
    <section
      data-testid="pdf-scope-step"
      className="space-y-4 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4"
    >
      <div>
        <h2 className="text-lg font-semibold">What's in this PDF?</h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          {fileName ? `${fileName} · ${pages}` : pages}
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="sr-only">What's in this PDF?</legend>
        <ScopeOption
          checked={scope === 'one'}
          onSelect={() => setScope('one')}
          label="This is one recipe"
          hint="Every page is read together into a single recipe — the usual case for a recipe printed or saved from a website."
        />
        <ScopeOption
          checked={scope === 'split'}
          onSelect={() => setScope('split')}
          label="This is a cookbook — split by page"
          hint="Each page becomes its own recipe to review, the way a scanned cookbook works. You can merge pages that belong together afterwards."
        />
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onConfirm(scope)}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
        >
          Continue
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

function ScopeOption({
  checked,
  onSelect,
  label,
  hint,
}: {
  checked: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm ${
        checked
          ? 'border-stone-900 dark:border-stone-100 bg-stone-50 dark:bg-stone-800'
          : 'border-stone-300 dark:border-stone-600 hover:bg-stone-50 dark:hover:bg-stone-800'
      }`}
    >
      <input type="radio" name="pdf-scope" className="mt-1" checked={checked} onChange={onSelect} />
      <span>
        <span className="font-medium text-stone-900 dark:text-stone-100">{label}</span>
        <span className="mt-0.5 block text-xs text-stone-600 dark:text-stone-400">{hint}</span>
      </span>
    </label>
  );
}
