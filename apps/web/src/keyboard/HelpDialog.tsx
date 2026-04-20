import type { Shortcut } from './shortcuts.js';

export function HelpDialog({
  open,
  onClose,
  shortcuts,
}: {
  open: boolean;
  onClose: () => void;
  shortcuts: readonly Shortcut[];
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg ring-1 ring-stone-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-stone-600 hover:bg-stone-100"
          >
            Esc
          </button>
        </div>
        <dl className="space-y-2 text-sm">
          {shortcuts.map((s) => (
            <div key={s.keys} className="flex items-baseline justify-between gap-4">
              <dt className="text-stone-700">{s.description}</dt>
              <dd className="flex gap-1">
                {s.keys.split(' ').map((k, i) => (
                  <kbd
                    key={`${s.keys}-${i}`}
                    className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-xs text-stone-700"
                  >
                    {k === '/' ? '/' : k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4 border-t border-stone-200 pt-2 text-stone-500">
            <dt>Open this dialog</dt>
            <dd>
              <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-xs">
                ?
              </kbd>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
