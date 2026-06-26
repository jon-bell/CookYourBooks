import { Link } from 'react-router-dom';

/**
 * First-run banner shown on the import entries when the user has no usable OCR
 * config (no own key and no household-shared setup). The detail now lives in the
 * guided wizard at /import/setup — this is just the friendly nudge into it.
 */
export function OcrSetupGuide() {
  return (
    <div
      data-testid="ocr-setup-guide"
      className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-950 dark:text-amber-100"
    >
      <h2 className="text-base font-semibold">Set up importing first</h2>
      <p className="mt-1 text-amber-900 dark:text-amber-200">
        To import recipes from photos and PDFs, connect a free key from Google — it takes about a
        minute. Or, if you're in a household, ask the owner to share theirs.
      </p>
      <div className="mt-3">
        <Link
          to="/import/setup"
          className="inline-block rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900"
        >
          Set up importing
        </Link>
      </div>
    </div>
  );
}
