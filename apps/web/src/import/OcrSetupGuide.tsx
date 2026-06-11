import { Link } from 'react-router-dom';

/**
 * First-run guidance shown on the import entry when the user has no usable
 * OCR config (no own key and no household-shared setup). Walks them through
 * getting a key, pasting it in Settings, and picking a model.
 */
export function OcrSetupGuide() {
  return (
    <div
      data-testid="ocr-setup-guide"
      className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-950 dark:text-amber-100"
    >
      <h2 className="text-base font-semibold">Set up OCR to import recipes</h2>
      <p className="mt-1 text-amber-900 dark:text-amber-200">
        Importing photos and PDFs uses a vision AI model with your own API key. It takes a minute to
        set up — or, if you're in a household, ask the owner to share theirs.
      </p>
      <ol className="mt-3 list-decimal space-y-2 pl-5">
        <li>
          <span className="font-medium">Get an API key.</span> For Google Gemini, create one free at{' '}
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Google AI Studio
          </a>
          . Any OpenAI-compatible provider (OpenAI, Groq, Together, OpenRouter…) works too.
        </li>
        <li>
          <span className="font-medium">
            Paste it into{' '}
            <Link to="/settings/llm" className="underline">
              Settings
            </Link>
          </span>{' '}
          under “OCR keys”. Your key is encrypted server-side and never leaves in the browser
          bundle.
        </li>
        <li>
          <span className="font-medium">Pick a model and prompt</span> (sensible defaults are
          pre-filled) and come back here to import.
        </li>
      </ol>
      <div className="mt-3">
        <Link
          to="/settings/llm"
          className="inline-block rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900"
        >
          Go to Settings
        </Link>
      </div>
    </div>
  );
}
