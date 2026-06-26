import { type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * Minimal dropdown menu: trigger button + absolutely-positioned panel.
 * Same open/close contract as ThemePicker's popover (outside pointer-down
 * and Escape close it; Escape also returns focus to the trigger). Children
 * get the `close` callback so stateful items (file pickers, async actions)
 * can dismiss the menu before doing their work — important for anything
 * that opens a native dialog, which would otherwise race the outside-click
 * handler.
 */
export function DropdownMenu({
  label,
  trigger,
  align = 'right',
  triggerClassName,
  testId,
  children,
}: {
  /** Accessible name for the trigger button. */
  label: string;
  /** Visible trigger content; defaults to a ⋯ glyph. */
  trigger?: ReactNode;
  align?: 'left' | 'right';
  /** Overrides the default toolbar-button styling of the trigger. */
  triggerClassName?: string;
  testId?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        className={
          triggerClassName ??
          'inline-flex h-9 min-w-9 items-center justify-center rounded-md px-2 text-sm text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800'
        }
      >
        {trigger ?? <span aria-hidden>⋯</span>}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          className={`absolute z-20 mt-1 min-w-44 rounded-md border border-stone-200 bg-white p-1 text-sm shadow-md dark:border-stone-700 dark:bg-stone-900 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** A standard full-width menu item button for DropdownMenu panels. */
export function DropdownMenuItem({
  onSelect,
  tone = 'default',
  disabled,
  testId,
  title,
  children,
}: {
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  testId?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      disabled={disabled}
      data-testid={testId}
      title={title}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left disabled:opacity-50 ${
        tone === 'danger'
          ? 'text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/40'
          : 'text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800'
      }`}
    >
      {children}
    </button>
  );
}
