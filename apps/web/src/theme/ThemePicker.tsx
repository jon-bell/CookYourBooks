import { useEffect, useRef, useState } from 'react';
import { useTheme, type ThemePref } from './ThemeProvider.js';

// Inline SVGs so we don't pull in an icon library for three glyphs.
// Each is a 1.25rem (h-5 w-5) outline icon styled via currentColor.

function SunIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
    </svg>
  );
}

function MonitorIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

const OPTIONS: Array<{
  value: ThemePref;
  label: string;
  Icon: (p: { className?: string }) => React.JSX.Element;
}> = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
];

export function ThemePicker() {
  const { pref, resolved, setPref } = useTheme();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | undefined>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  function pick(p: ThemePref) {
    setPref(p);
    setOpen(false);
    const label = OPTIONS.find((o) => o.value === p)?.label ?? p;
    setToast(`Theme: ${label}`);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), 1500);
  }

  // The trigger icon reflects the *resolved* theme (so System shows
  // whichever mode is currently active), with a small dot if the pref
  // is System so the user can still distinguish auto vs explicit.
  const TriggerIcon = resolved === 'dark' ? MoonIcon : SunIcon;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Theme: ${pref}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-stone-300 dark:border-stone-600 bg-white text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
      >
        <TriggerIcon className="h-5 w-5" />
        {pref === 'system' && (
          <span
            aria-hidden="true"
            className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-stone-500 dark:bg-stone-400"
          />
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-36 rounded-md border border-stone-200 bg-white p-1 text-sm shadow-md dark:border-stone-700 dark:bg-stone-900"
        >
          {OPTIONS.map(({ value, label, Icon }) => {
            const active = value === pref;
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => pick(value)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${
                  active
                    ? 'bg-stone-100 font-medium text-stone-900 dark:bg-stone-800 dark:text-stone-100'
                    : 'text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-stone-900 px-3 py-1.5 text-xs font-medium text-white shadow-lg dark:bg-stone-100 dark:text-stone-900"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
