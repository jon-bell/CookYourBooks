import { useCallback, useEffect, useRef, useState } from 'react';

import { SAFE_BOTTOM, SAFE_TOP, SAFE_X, TAP_TARGET } from '../components/mobileSafeArea.js';
import { DEFAULT_MARKER, type PageKind, type PageMarker, type ScannedPage } from './pageMarker.js';
import { plannerHapticTick } from './plannerCapture.js';

const DEFAULT_MAX_SHOTS = 200;
const DEFAULT_JPEG_QUALITY = 0.85;
const SHUTTER_DEBOUNCE_MS = 350;

export interface CameraScannerProps {
  onDone: (pages: ScannedPage[]) => void;
  onCancel: () => void;
  /** Called when the live camera can't be used (permission denied / no
   *  camera) and the user opts to fall back to the system camera. */
  onFallback?: () => void;
  maxShots?: number;
  jpegQuality?: number;
}

type Shot = { id: string; file: File; url: string; marker: PageMarker };
type Status = 'starting' | 'live' | 'denied' | 'no-camera' | 'error';

const KIND_OPTIONS: ReadonlyArray<{ kind: PageKind; label: string; aria: string }> = [
  { kind: 'RECIPE', label: 'Recipe', aria: 'Recipe page' },
  { kind: 'TOC', label: 'Contents', aria: 'Table of contents page' },
  { kind: 'NOTES', label: 'Notes', aria: 'Intro / notes page' },
];

/** Screen-reader label for a thumbnail — the corner badges are visual-only. */
function ariaForShot(index: number, m: PageMarker): string {
  const parts = [`Page ${index + 1}`];
  if (m.joinsPrevious && index > 0) parts.push('joins previous page');
  if (m.kind === 'TOC') parts.push('table of contents');
  else if (m.kind === 'NOTES') parts.push('intro and notes');
  return `${parts.join(', ')}. Tap for options.`;
}

function classifyError(err: unknown): Status {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (
    name === 'NotFoundError' ||
    name === 'OverconstrainedError' ||
    name === 'DevicesNotFoundError'
  ) {
    return 'no-camera';
  }
  return 'error';
}

/**
 * A full-screen live-viewfinder camera for rapid "speed scanning" of
 * cookbook pages. Each shutter tap grabs the current video frame into a JPEG
 * without leaving the screen, so the user can fire page after page.
 *
 * Pure capture: it never uploads or routes — it hands the captured `File[]`
 * back via `onDone` (or `onCancel` if the user backs out with nothing). The
 * orchestrator in `scanPages.ts` owns mounting + the fallback chain, so this
 * component stays reusable. Captured frames are full-resolution; the upload
 * pipeline (`prepareImage`) does the downscale, so we don't double-process.
 */
export function CameraScanner({
  onDone,
  onCancel,
  onFallback,
  maxShots = DEFAULT_MAX_SHOTS,
  jpegQuality = DEFAULT_JPEG_QUALITY,
}: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastShotAt = useRef(0);

  const [shots, setShots] = useState<Shot[]>([]);
  const [status, setStatus] = useState<Status>('starting');
  const [errorMsg, setErrorMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [sheetForId, setSheetForId] = useState<string>();
  // Chain mode: while on, each new shot continues the previous shot's recipe
  // (the pages are folded together at upload). One tap per multi-page recipe.
  const [chainNext, setChainNext] = useState(false);

  // Revoke object URLs on unmount.
  const urlsRef = useRef<string[]>([]);
  useEffect(() => {
    urlsRef.current = shots.map((s) => s.url);
  }, [shots]);
  useEffect(
    () => () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
    },
    [],
  );

  // Acquire the camera on mount; tear it down on unmount. iOS WKWebView
  // tends to end the track when the app backgrounds, so re-acquire when the
  // page becomes visible again.
  useEffect(() => {
    let cancelled = false;

    function stop() {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('error');
        setErrorMsg('This browser does not support camera access.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const caps =
          (
            track as unknown as { getCapabilities?: () => { torch?: boolean } }
          ).getCapabilities?.() ?? {};
        setTorchSupported(!!caps.torch);
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => {});
        }
        setStatus('live');
      } catch (err) {
        if (cancelled) return;
        setStatus(classifyError(err));
        setErrorMsg((err as Error)?.message);
      }
    }

    function onVisibility() {
      if (document.visibilityState !== 'visible') return;
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') {
        stop();
        void start();
      } else {
        void videoRef.current?.play().catch(() => {});
      }
    }

    void start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, []);

  const captureFrame = useCallback(async (): Promise<File | undefined> => {
    const v = videoRef.current;
    const canvas = canvasRef.current;
    if (!v || !canvas || status !== 'live') return undefined;
    if (!v.videoWidth || !v.videoHeight) return undefined;
    // Size the canvas to the video's INTRINSIC resolution (not the
    // CSS-scaled, object-cover preview), so we capture the full frame.
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/jpeg', jpegQuality),
    );
    if (!blob) return undefined;
    return new File([blob], `scan-${String(shots.length + 1).padStart(3, '0')}.jpg`, {
      type: 'image/jpeg',
    });
  }, [status, jpegQuality, shots.length]);

  const onShutter = useCallback(async () => {
    const now = Date.now();
    if (busy || now - lastShotAt.current < SHUTTER_DEBOUNCE_MS) return;
    if (shots.length >= maxShots) {
      setErrorMsg(`Maximum ${maxShots} pages reached.`);
      return;
    }
    lastShotAt.current = now;
    setBusy(true);
    try {
      const file = await captureFrame();
      if (!file) return;
      const url = URL.createObjectURL(file);
      setShots((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          file,
          url,
          marker: { ...DEFAULT_MARKER, joinsPrevious: chainNext && prev.length > 0 },
        },
      ]);
      void plannerHapticTick();
    } finally {
      setBusy(false);
    }
  }, [busy, shots.length, maxShots, captureFrame, chainNext]);

  const remove = useCallback((id: string) => {
    setShots((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((s) => s.id !== id);
    });
    setSheetForId(undefined);
  }, []);

  const setMarker = useCallback((id: string, patch: Partial<PageMarker>) => {
    setShots((prev) =>
      prev.map((s) => (s.id === id ? { ...s, marker: { ...s.marker, ...patch } } : s)),
    );
  }, []);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ torch: !torchOn }],
      } as unknown as MediaTrackConstraints);
      setTorchOn((v) => !v);
    } catch {
      // Torch is a progressive enhancement — ignore failures.
    }
  }

  function done() {
    if (shots.length === 0) {
      onCancel();
      return;
    }
    onDone(shots.map((s) => ({ file: s.file, marker: s.marker })));
  }

  const isLive = status === 'live';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Camera scanner"
      data-testid="camera-scanner"
      // `h-[100dvh] w-screen` (not `inset-0`/`h-screen`) pins the surface to the
      // *visible* viewport: `inset-0`/`100vh` resolve to the large mobile
      // viewport, pushing the shutter + strip under the browser chrome / home
      // indicator. dvh tracks the dynamic viewport and shrinks with the chrome.
      className="fixed left-0 top-0 z-50 flex h-[100dvh] w-screen flex-col bg-stone-950 text-white"
    >
      <canvas ref={canvasRef} className="hidden" aria-hidden />

      <header
        className={`flex items-center justify-between gap-2 py-3 text-sm ${SAFE_TOP} ${SAFE_X}`}
      >
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close scanner"
          className={`inline-flex items-center justify-center rounded-full text-stone-200 hover:bg-stone-800 ${TAP_TARGET}`}
        >
          <span aria-hidden className="text-xl leading-none">
            ✕
          </span>
        </button>
        <div className="text-stone-300" aria-live="polite">
          {shots.length} / {maxShots}
        </div>
        <button
          type="button"
          onClick={done}
          disabled={shots.length === 0}
          className="rounded-md bg-amber-500 px-3 py-1.5 font-medium text-stone-950 disabled:opacity-40"
        >
          Done
        </button>
      </header>

      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${isLive ? '' : 'opacity-0'}`}
        />
        {!isLive && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            {status === 'starting' ? (
              <p className="text-stone-300">Starting camera…</p>
            ) : (
              <>
                <p className="text-stone-200">
                  {status === 'denied'
                    ? 'Camera access was blocked. Enable it in settings to scan.'
                    : status === 'no-camera'
                      ? 'No camera was found on this device.'
                      : errorMsg || 'The camera could not be started.'}
                </p>
                {onFallback && (
                  <button
                    type="button"
                    onClick={onFallback}
                    className={`rounded-md bg-white px-4 py-2 font-medium text-stone-950 ${TAP_TARGET}`}
                  >
                    Use the system camera
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {isLive && torchSupported && (
          <button
            type="button"
            onClick={toggleTorch}
            aria-pressed={torchOn}
            aria-label="Toggle flashlight"
            className={`absolute right-[max(1rem,env(safe-area-inset-right))] top-[max(1rem,env(safe-area-inset-top))] inline-flex items-center justify-center rounded-full bg-stone-900/60 ${TAP_TARGET}`}
          >
            <span aria-hidden className="text-lg">
              {torchOn ? '🔦' : '💡'}
            </span>
          </button>
        )}
      </div>

      {chainNext && (
        <p className="px-4 pt-2 text-center text-xs text-sky-300" aria-live="polite">
          ⛓ Chain on — new photos join the same recipe
        </p>
      )}
      <div className={`grid grid-cols-3 items-center py-3 ${SAFE_X}`}>
        <button
          type="button"
          role="switch"
          aria-checked={chainNext}
          aria-label="Chain mode: each new photo continues the previous recipe"
          onClick={() => setChainNext((v) => !v)}
          className={`inline-flex justify-self-start items-center justify-center rounded-full ${TAP_TARGET} ${
            chainNext ? 'bg-sky-600 text-white' : 'bg-stone-800 text-stone-300'
          }`}
        >
          <span aria-hidden className="text-lg">
            ⛓
          </span>
        </button>
        <button
          type="button"
          onClick={onShutter}
          disabled={!isLive || busy}
          aria-label="Capture page"
          className="h-20 w-20 justify-self-center rounded-full border-4 border-white bg-white/90 shadow-lg disabled:opacity-40"
        />
        <span aria-hidden />
      </div>

      <div className={`border-t border-stone-800 bg-stone-900 py-3 ${SAFE_BOTTOM} ${SAFE_X}`}>
        {shots.length === 0 ? (
          <p className="text-center text-xs text-stone-500">Captured pages appear here.</p>
        ) : (
          <ol className="flex gap-2 overflow-x-auto pb-1">
            {shots.map((s, i) => {
              const m = s.marker;
              const isCont = m.joinsPrevious && i > 0;
              return (
                <li key={s.id} className="shrink-0">
                  <button
                    type="button"
                    aria-label={ariaForShot(i, m)}
                    onClick={() => setSheetForId(s.id)}
                    className={`relative block h-20 w-16 overflow-hidden rounded ring-2 ${
                      isCont ? 'ring-sky-500' : 'ring-stone-700'
                    }`}
                  >
                    <img
                      src={s.url}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                    {isCont && (
                      <span
                        className="absolute left-0 top-0 bg-sky-600/90 px-1 text-[10px] leading-tight"
                        aria-hidden
                      >
                        ⛓
                      </span>
                    )}
                    {m.kind === 'TOC' && (
                      <span
                        className="absolute right-0 top-0 bg-stone-950/80 px-1 text-[10px] leading-tight"
                        aria-hidden
                      >
                        ToC
                      </span>
                    )}
                    {m.kind === 'NOTES' && (
                      <span
                        className="absolute right-0 top-0 bg-stone-950/80 px-1 text-[10px] leading-tight"
                        aria-hidden
                      >
                        ✎
                      </span>
                    )}
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

      {sheetForId &&
        (() => {
          const idx = shots.findIndex((s) => s.id === sheetForId);
          const shot = shots[idx];
          if (!shot) return null;
          const m = shot.marker;
          return (
            <div
              className="fixed inset-0 z-50 flex items-end bg-stone-950/60"
              onClick={() => setSheetForId(undefined)}
            >
              <div
                role="dialog"
                aria-label={`Page ${idx + 1} options`}
                onClick={(e) => e.stopPropagation()}
                className={`w-full space-y-3 rounded-t-2xl bg-stone-900 p-4 ${SAFE_BOTTOM} ${SAFE_X}`}
              >
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-stone-400">Page type</p>
                  <div role="radiogroup" aria-label="Page type" className="grid grid-cols-3 gap-2">
                    {KIND_OPTIONS.map((opt) => (
                      <button
                        key={opt.kind}
                        type="button"
                        role="radio"
                        aria-checked={m.kind === opt.kind}
                        aria-label={opt.aria}
                        onClick={() => setMarker(shot.id, { kind: opt.kind })}
                        className={`rounded-md px-2 py-3 text-sm ${TAP_TARGET} ${
                          m.kind === opt.kind
                            ? 'bg-amber-500 font-medium text-stone-950'
                            : 'bg-stone-800 text-stone-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {idx > 0 && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={m.joinsPrevious}
                    onClick={() => setMarker(shot.id, { joinsPrevious: !m.joinsPrevious })}
                    className={`flex w-full items-center justify-between rounded-md px-4 py-3 ${TAP_TARGET} ${
                      m.joinsPrevious ? 'bg-sky-600 text-white' : 'bg-stone-800 text-stone-200'
                    }`}
                  >
                    <span>⛓ Joins previous page</span>
                    <span aria-hidden>{m.joinsPrevious ? 'On' : 'Off'}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => remove(shot.id)}
                  className={`block w-full rounded-md bg-red-600 px-4 py-3 font-medium text-white ${TAP_TARGET}`}
                >
                  Delete page
                </button>
                <button
                  type="button"
                  onClick={() => setSheetForId(undefined)}
                  className={`block w-full rounded-md bg-stone-700 px-4 py-3 ${TAP_TARGET}`}
                >
                  Done
                </button>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
