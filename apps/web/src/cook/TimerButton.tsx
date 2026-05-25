import { useCallback, useEffect, useRef, useState } from 'react';

type TimerState = 'idle' | 'running' | 'paused' | 'done';

interface PersistedTimer {
  state: TimerState;
  remainingSec: number;
  // When running, the wall-clock ms when we last computed remaining;
  // used to recompute on resume so a quick back/forth doesn't lose
  // seconds.
  lastTickAt?: number;
}

interface Props {
  durationSec: number;
  /**
   * Stable per-step key (e.g. `${recipeId}:${instructionId}:${subIdx}`)
   * for sessionStorage persistence. Cook Mode reuses the same step
   * components when navigating, so without persistence a 20-minute
   * timer would reset every time the user advanced and came back.
   */
  persistKey: string;
}

async function lightTap(): Promise<void> {
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    /* not supported; no-op */
  }
}

function readPersisted(key: string, fallback: number): PersistedTimer {
  if (typeof sessionStorage === 'undefined') return { state: 'idle', remainingSec: fallback };
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return { state: 'idle', remainingSec: fallback };
    const parsed = JSON.parse(raw) as PersistedTimer;
    if (parsed.state === 'running' && typeof parsed.lastTickAt === 'number') {
      const elapsed = Math.floor((Date.now() - parsed.lastTickAt) / 1000);
      const remaining = Math.max(0, parsed.remainingSec - elapsed);
      return remaining === 0
        ? { state: 'done', remainingSec: 0 }
        : { state: 'running', remainingSec: remaining, lastTickAt: Date.now() };
    }
    return parsed;
  } catch {
    return { state: 'idle', remainingSec: fallback };
  }
}

function writePersisted(key: string, value: PersistedTimer): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sessionStorage can be disabled in some browser modes */
  }
}

function formatMMSS(sec: number): string {
  if (sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function TimerButton({ durationSec, persistKey }: Props) {
  const initial = readPersisted(persistKey, durationSec);
  const [state, setState] = useState<TimerState>(initial.state);
  const [remaining, setRemaining] = useState<number>(
    initial.state === 'idle' ? durationSec : initial.remainingSec,
  );
  const tickRef = useRef<number | null>(null);

  const persist = useCallback(
    (next: PersistedTimer) => writePersisted(persistKey, next),
    [persistKey],
  );

  // Drive countdown.
  useEffect(() => {
    if (state !== 'running') {
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      tickRef.current = null;
      return;
    }
    tickRef.current = window.setInterval(() => {
      setRemaining((r) => {
        const next = r - 1;
        if (next <= 0) {
          setState('done');
          void lightTap();
          persist({ state: 'done', remainingSec: 0 });
          // Optional desktop notification on completion. Falls back
          // silently when the user hasn't granted permission.
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
              new Notification('Timer done', { body: 'Cook mode step complete' });
            } catch {
              /* some platforms forbid Notification(); ignore */
            }
          }
          return 0;
        }
        persist({ state: 'running', remainingSec: next, lastTickAt: Date.now() });
        return next;
      });
    }, 1000);
    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [state, persist]);

  function start() {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      // Best effort. User can still ignore the prompt.
      void Notification.requestPermission().catch(() => {});
    }
    setState('running');
    persist({ state: 'running', remainingSec: remaining, lastTickAt: Date.now() });
  }

  function pause() {
    setState('paused');
    persist({ state: 'paused', remainingSec: remaining });
  }

  function reset() {
    setState('idle');
    setRemaining(durationSec);
    persist({ state: 'idle', remainingSec: durationSec });
  }

  if (state === 'done') {
    return (
      <button
        type="button"
        onClick={reset}
        className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-900 ring-1 ring-emerald-300 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:ring-emerald-700"
        data-testid="timer-done"
      >
        Done · reset {formatMMSS(durationSec)}
      </button>
    );
  }
  if (state === 'running') {
    return (
      <button
        type="button"
        onClick={pause}
        className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-amber-900 ring-1 ring-amber-300 hover:bg-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-700"
        data-testid="timer-running"
      >
        {formatMMSS(remaining)} · pause
      </button>
    );
  }
  if (state === 'paused') {
    return (
      <span className="inline-flex gap-1">
        <button
          type="button"
          onClick={start}
          className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-amber-900 ring-1 ring-amber-300 hover:bg-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-700"
        >
          {formatMMSS(remaining)} · resume
        </button>
        <button
          type="button"
          onClick={reset}
          className="rounded-full px-2 text-xs text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
          aria-label="Reset timer"
        >
          ↺
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={start}
      className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-stone-700 ring-1 ring-stone-300 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:ring-stone-600 dark:hover:bg-stone-700"
      data-testid="timer-start"
    >
      Start {formatMMSS(durationSec)}
    </button>
  );
}
