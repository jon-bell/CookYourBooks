/**
 * First-launch tutorial + "?"-button help for the live camera scanner.
 * Shown automatically once (localStorage `cookyourbooks.scan.tutorial.v1`)
 * when the camera first goes live, and re-openable any time from the
 * scanner header's "?" button. Rendered inside the scanner dialog (z-50),
 * hence z-[60]. Dark styling to match the camera chrome.
 *
 * The hardware-shutter section only appears when the native volume-button
 * plugin is present (`showVolumeButtons`) — on the web/Android there are no
 * volume shortcuts to explain.
 */
export const SCAN_TUTORIAL_SEEN_KEY = 'cookyourbooks.scan.tutorial.v1';

export function hasSeenScanTutorial(): boolean {
  try {
    return localStorage.getItem(SCAN_TUTORIAL_SEEN_KEY) === '1';
  } catch {
    // Private mode / storage disabled: claim seen so the modal can't nag on
    // every single open.
    return true;
  }
}

export function markScanTutorialSeen(): void {
  try {
    localStorage.setItem(SCAN_TUTORIAL_SEEN_KEY, '1');
  } catch {
    /* private mode / storage disabled — in-memory session only */
  }
}

export function ScannerHelpModal({
  showVolumeButtons,
  onDismiss,
}: {
  showVolumeButtons: boolean;
  onDismiss: () => void;
}) {
  const rows: { icon: string; title: string; body: string }[] = [
    {
      icon: '◉',
      title: 'Shutter',
      body: 'Snap one page per tap — no need to stop between shots. Each page becomes its own recipe by default.',
    },
    {
      icon: '⛓',
      title: 'Join',
      body: 'A recipe continues onto this page? The Join shutter chains the shot onto the previous page so they stay one recipe.',
    },
    {
      icon: '▤',
      title: 'Contents',
      body: 'Photographing the table of contents? The Contents shutter tags the page so OCR extracts the recipe list instead of a recipe.',
    },
  ];
  if (showVolumeButtons) {
    rows.push({
      icon: '🔊',
      title: 'Volume buttons',
      body: 'Press volume UP to snap a page and chain it to the last one (multi-page recipe). Press volume DOWN for a plain shot. Works without touching the screen.',
    });
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scanner help"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-stone-950/80 p-6"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-md rounded-lg border border-stone-700 bg-stone-900 p-5 text-stone-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">Scanning pages</h2>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            className="rounded p-1 text-stone-400 hover:bg-stone-800"
          >
            ×
          </button>
        </div>
        <ul className="mt-4 space-y-4">
          {rows.map((row) => (
            <li key={row.title} className="flex gap-3">
              <span aria-hidden className="w-7 shrink-0 text-center text-xl leading-6">
                {row.icon}
              </span>
              <div>
                <h3 className="text-sm font-semibold">{row.title}</h3>
                <p className="mt-0.5 text-sm text-stone-300">{row.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-stone-400">
          When you&rsquo;re done, you&rsquo;ll group the pages into recipes on the next screen —
          nothing here is final.
        </p>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-400"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
