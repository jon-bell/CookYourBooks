import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SAFE_TOP, SAFE_BOTTOM, SAFE_X, TAP_TARGET } from '../components/mobileSafeArea.js';

export type MultiShotCameraDialogProps = {
  maxShots: number;
  onShutter: () => Promise<File | undefined>;
  onDone: (files: File[]) => void;
  onCancel: () => void;
};

type Shot = {
  id: string;
  file: File;
  url: string;
};

export function MultiShotCameraDialog({
  maxShots,
  onShutter,
  onDone,
  onCancel,
}: MultiShotCameraDialogProps) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [retakeId, setRetakeId] = useState<string | undefined>();
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoFiredRef = useRef(false);

  const urlsRef = useRef<string[]>([]);
  useEffect(() => {
    urlsRef.current = shots.map((s) => s.url);
  }, [shots]);
  useEffect(() => {
    return () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  const remaining = maxShots - shots.length;

  const fireShutter = useCallback(async () => {
    if (busy) return;
    if (!retakeId && remaining <= 0) {
      setError(`Maximum ${maxShots} photos reached.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const file = await onShutter();
      if (!file) {
        setBusy(false);
        return;
      }
      const url = URL.createObjectURL(file);
      if (retakeId) {
        setShots((prev) => {
          const next = prev.map((s) => {
            if (s.id !== retakeId) return s;
            URL.revokeObjectURL(s.url);
            return { id: s.id, file, url };
          });
          return next;
        });
        setRetakeId(undefined);
      } else {
        setShots((prev) => [...prev, { id: crypto.randomUUID(), file, url }]);
      }
    } catch (err) {
      setError((err as Error).message ?? 'Failed to capture photo.');
    } finally {
      setBusy(false);
    }
  }, [busy, retakeId, remaining, maxShots, onShutter]);

  useEffect(() => {
    if (autoFiredRef.current) return;
    autoFiredRef.current = true;
    void fireShutter();
  }, [fireShutter]);

  const remove = (id: string) => {
    setShots((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((s) => s.id !== id);
    });
    if (retakeId === id) setRetakeId(undefined);
  };

  const startLongPress = (id: string) => {
    clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      const action = window.prompt(
        'Retake (r) or delete (d) this photo? Enter r or d:',
        'r',
      );
      if (action === 'r') {
        setRetakeId(id);
      } else if (action === 'd') {
        remove(id);
      }
    }, 450);
  };

  const cancelLongPress = () => {
    clearTimeout(longPressTimer.current);
  };

  const done = () => {
    if (shots.length === 0) {
      onCancel();
      return;
    }
    onDone(shots.map((s) => s.file));
  };

  const cancel = () => {
    onCancel();
  };

  const shutterLabel = useMemo(() => {
    if (busy) return 'Capturing…';
    if (retakeId) return 'Retake photo';
    return shots.length === 0 ? 'Take photo' : 'Take another';
  }, [busy, retakeId, shots.length]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Multi-shot camera"
      data-testid="multi-shot-camera-dialog"
      // dvh + full width pins to the visible viewport; see CameraScanner.
      className="fixed left-0 top-0 z-50 flex h-[100dvh] w-screen flex-col bg-stone-950 text-white"
    >
      <header
        className={`flex items-center justify-between py-3 text-sm ${SAFE_TOP} ${SAFE_X}`}
      >
        <button
          type="button"
          onClick={cancel}
          aria-label="Close scanner"
          className={`inline-flex items-center justify-center rounded-full text-stone-200 hover:bg-stone-800 dark:hover:bg-stone-200 ${TAP_TARGET}`}
        >
          <span aria-hidden className="text-xl leading-none">
            ✕
          </span>
        </button>
        <div className="text-stone-300">
          {shots.length} / {maxShots}
          {retakeId ? ' · retaking' : ''}
        </div>
        <button
          type="button"
          onClick={done}
          disabled={busy || shots.length === 0}
          className="rounded-md bg-amber-500 px-3 py-1.5 font-medium text-stone-950 disabled:opacity-40"
        >
          Done
        </button>
      </header>

      <div className="flex-1 px-4 py-2 text-center text-sm text-stone-400">
        {error ? (
          <span className="text-red-300">{error}</span>
        ) : retakeId ? (
          <span>Tap “Retake photo” to replace the selected shot.</span>
        ) : shots.length === 0 ? (
          <span>Frame your first page and tap the shutter.</span>
        ) : (
          <span>Long-press a thumbnail to retake or delete it.</span>
        )}
      </div>

      <div className="px-4 pb-3">
        <button
          type="button"
          onClick={fireShutter}
          disabled={busy || (!retakeId && remaining <= 0)}
          className="block w-full rounded-full bg-white dark:bg-stone-900 px-4 py-4 text-base font-semibold text-stone-950 shadow-lg disabled:opacity-40"
        >
          {shutterLabel}
        </button>
      </div>

      <div
        className={`border-t border-stone-800 bg-stone-900 dark:bg-stone-100 py-3 ${SAFE_BOTTOM} ${SAFE_X}`}
      >
        {shots.length === 0 ? (
          <p className="text-center text-xs text-stone-500 dark:text-stone-400">No photos yet.</p>
        ) : (
          <ol className="flex gap-2 overflow-x-auto pb-1">
            {shots.map((s, i) => {
              const isRetake = retakeId === s.id;
              return (
                <li key={s.id} className="shrink-0">
                  <button
                    type="button"
                    aria-label={`Photo ${i + 1}. Long-press to retake or delete.`}
                    onPointerDown={() => startLongPress(s.id)}
                    onPointerUp={cancelLongPress}
                    onPointerLeave={cancelLongPress}
                    onPointerCancel={cancelLongPress}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      startLongPress(s.id);
                    }}
                    className={`relative block h-20 w-16 overflow-hidden rounded ring-2 ${
                      isRetake ? 'ring-amber-400' : 'ring-stone-700'
                    }`}
                  >
                    <img
                      src={s.url}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                    <span className="absolute bottom-0 left-0 right-0 bg-stone-950/70 px-1 py-0.5 text-center text-[10px] text-stone-100">
                      {i + 1}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
