import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastTone = 'info' | 'success' | 'warn';

interface ToastContextValue {
  showToast: (text: string, tone?: ToastTone, ms?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * App-wide transient toast. One toast at a time — a new one replaces the
 * current one and restarts the dismiss timer. Originally lived inline in
 * App.tsx's ShareIntentListener; promoted so any feature (share links,
 * import feedback, …) can surface lightweight status without its own state.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; tone: ToastTone } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showToast = useCallback((text: string, tone: ToastTone = 'info', ms = 4000): void => {
    setToast({ text, tone });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), ms);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const palette =
    toast?.tone === 'success'
      ? 'bg-emerald-700 text-white dark:bg-emerald-500 dark:text-emerald-950'
      : toast?.tone === 'warn'
        ? 'bg-amber-600 text-white dark:bg-amber-400 dark:text-amber-950'
        : 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900';

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`pointer-events-none fixed left-1/2 top-[max(1rem,env(safe-area-inset-top))] z-50 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-medium shadow-lg ${palette}`}
        >
          {toast.text}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
