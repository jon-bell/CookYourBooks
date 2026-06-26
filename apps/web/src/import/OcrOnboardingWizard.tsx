import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { getEffectiveOcrConfig, setOcrKey, validateOcrKey } from './api.js';

/**
 * Gemini-first onboarding wizard for non-technical users. Walks through, in
 * plain language: what importing needs → how to get a free Google key (exact
 * clicks) → paste + live-validate + save → done. All the technical surface
 * (OpenAI-compatible, base URL, model/prompt) stays behind the "Advanced setup"
 * link to /settings/llm. Replaces the old "go read Settings" hand-off.
 *
 * Validation (`validateOcrKey`) makes a free, zero-token call to confirm the key
 * actually works before it's stored, so a typo'd / wrong key is caught here
 * rather than on the first failed import.
 */

const AI_STUDIO_URL = 'https://aistudio.google.com/apikey';

type Step = 'intro' | 'get-key' | 'paste' | 'done';

function friendlyError(reason: string | undefined): string {
  if (reason === 'auth')
    return "That key didn't work. Make sure you copied the whole thing — it should start with “AIza”.";
  if (reason === 'network')
    return "Couldn't reach Google. Check your internet connection and try again.";
  return 'Something went wrong checking that key. Double-check it and try again.';
}

export function OcrOnboardingWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Where to send the user when they finish. Defaults to the import entry.
  const destination = searchParams.get('from') || '/import/new';

  const [ready, setReady] = useState<boolean | null>(null); // null = still checking
  const [step, setStep] = useState<Step>('intro');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Skip-if-ready: deep-links and household members who already have a usable
  // config shouldn't be pushed through setup.
  useEffect(() => {
    let cancelled = false;
    void getEffectiveOcrConfig()
      .then((cfg) => {
        if (!cancelled) setReady(cfg !== null);
      })
      .catch(() => {
        if (!cancelled) setReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submitKey() {
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await validateOcrKey('gemini', trimmed);
      if (!result.ok) {
        setError(friendlyError(result.reason));
        return;
      }
      await setOcrKey('gemini', trimmed);
      setStep('done');
    } catch (e) {
      setError((e as Error).message || friendlyError('other'));
    } finally {
      setBusy(false);
    }
  }

  const advancedLink = (
    <p className="text-xs text-stone-500 dark:text-stone-400">
      Already have a key, or using a different provider?{' '}
      <Link to="/settings/llm" className="underline">
        Advanced setup
      </Link>
    </p>
  );

  if (ready === null) {
    return (
      <div className="mx-auto max-w-lg py-12 text-center text-sm text-stone-500">Loading…</div>
    );
  }

  // Already configured — don't re-run setup.
  if (ready && step !== 'done') {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-8" data-testid="ocr-wizard-already-set">
        <h1 className="text-2xl font-semibold">You're already set up</h1>
        <p className="text-stone-600 dark:text-stone-300">
          Importing is ready to go — no setup needed.
        </p>
        <button
          type="button"
          onClick={() => navigate(destination)}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white dark:bg-stone-100 dark:text-stone-900"
        >
          Start importing
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6 py-4" data-testid="ocr-wizard">
      {step === 'intro' && (
        <section className="space-y-4">
          <h1 className="text-2xl font-semibold">Set up recipe importing</h1>
          <p className="text-stone-600 dark:text-stone-300">
            CookYourBooks reads recipes from your photos and PDFs using Google's AI. To turn it on,
            you'll connect it with a <span className="font-medium">free</span> key from Google.
          </p>
          <ul className="space-y-1 text-sm text-stone-600 dark:text-stone-300">
            <li>• It's free for personal use.</li>
            <li>• It takes about 2 minutes.</li>
            <li>• You only do this once.</li>
          </ul>
          <button
            type="button"
            onClick={() => setStep('get-key')}
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white dark:bg-stone-100 dark:text-stone-900"
          >
            Get started
          </button>
          {advancedLink}
        </section>
      )}

      {step === 'get-key' && (
        <section className="space-y-4">
          <h1 className="text-2xl font-semibold">Get your free key from Google</h1>
          <p className="text-stone-600 dark:text-stone-300">
            Open Google AI Studio in a new tab and follow these steps:
          </p>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-stone-700 dark:text-stone-200">
            <li>Click the button below to open Google AI Studio.</li>
            <li>
              Sign in with your Google account if asked (the same one you use for Gmail works fine).
            </li>
            <li>
              Click <span className="font-medium">Create API key</span>.
            </li>
            <li>
              Click <span className="font-medium">Copy</span> to copy the key.
            </li>
            <li>Come back to this tab and paste it on the next step.</li>
          </ol>
          <a
            href={AI_STUDIO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-block rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white dark:bg-stone-100 dark:text-stone-900"
          >
            Open Google AI Studio →
          </a>
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => setStep('intro')}
              className="text-sm text-stone-500 underline"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep('paste')}
              className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800"
            >
              I have my key
            </button>
          </div>
          {advancedLink}
        </section>
      )}

      {step === 'paste' && (
        <section className="space-y-4">
          <h1 className="text-2xl font-semibold">Paste your key</h1>
          <p className="text-stone-600 dark:text-stone-300">
            Paste the key you copied from Google. We'll check that it works, then save it securely —
            it never leaves the server.
          </p>
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && key.trim() && !busy) void submitKey();
            }}
            placeholder="Paste your key here"
            data-testid="ocr-wizard-key-input"
            className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-sm dark:border-stone-600 dark:bg-stone-900"
          />
          {error && (
            <p className="text-sm text-red-700 dark:text-red-300" data-testid="ocr-wizard-error">
              {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setStep('get-key')}
              className="text-sm text-stone-500 underline"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void submitKey()}
              disabled={busy || !key.trim()}
              data-testid="ocr-wizard-continue"
              className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900"
            >
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </div>
          {advancedLink}
        </section>
      )}

      {step === 'done' && (
        <section className="space-y-4" data-testid="ocr-wizard-done">
          <h1 className="text-2xl font-semibold">You're all set! 🎉</h1>
          <p className="text-stone-600 dark:text-stone-300">
            Importing is ready to go. Snap a photo or share a PDF and we'll turn it into a recipe.
          </p>
          <button
            type="button"
            onClick={() => navigate(destination)}
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white dark:bg-stone-100 dark:text-stone-900"
          >
            Start importing
          </button>
        </section>
      )}
    </div>
  );
}
