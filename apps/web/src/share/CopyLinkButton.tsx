import { useState } from 'react';
import { copyToClipboard } from './shareUrl.js';

interface Props {
  url: string;
  /** Optional override label for the default state. */
  label?: string;
  /** Passed through so pages can match their button styling. */
  className?: string;
}

// Tiny button that copies a share URL and briefly acknowledges the
// action. Used for both recipe and collection pages when the owner
// has made the collection public.
export function CopyLinkButton({
  url,
  label = 'Copy link',
  className = 'rounded-md px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100',
}: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function onClick() {
    const ok = await copyToClipboard(url);
    setState(ok ? 'copied' : 'failed');
    window.setTimeout(() => setState('idle'), 1500);
  }

  const text = state === 'copied' ? 'Copied!' : state === 'failed' ? 'Copy failed' : label;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-live="polite"
      data-testid="copy-link-button"
      className={className}
    >
      {text}
    </button>
  );
}
