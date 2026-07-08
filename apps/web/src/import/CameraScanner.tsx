import { useCallback, useEffect, useRef, useState } from 'react';

import { SAFE_BOTTOM, SAFE_TOP, SAFE_X, TAP_TARGET } from '../components/mobileSafeArea.js';
import { DEFAULT_MARKER, type PageMarker, type ScannedPage } from './pageMarker.js';
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

/** Screen-reader label for a thumbnail — the corner badges are visual-only. */
function ariaForShot(index: number, m: PageMarker): string {
  const parts = [`Page ${index + 1}`];
  if (m.joinsPrevious && index > 0) parts.push('joins previous page');
  return `${parts.join(', ')}. Tap × to remove.`;
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
 * Layout is a strict 3-part flex column that always fits the visible viewport:
 * a `shrink-0` header, a single `flex-1 min-h-0` media region, and a
 * `shrink-0` control bar. Everything incremental (torch, the "chain on" hint,
 * the captured-pages strip) is an absolute OVERLAY inside the media region, so
 * it never adds a stacked row that pushes controls off-screen.
 *
 * Pure capture: it never uploads or routes — it hands the captured pages back
 * via `onDone` (each carrying its `joinsPrevious` chain marker; page-type
 * classification + grouping happen later on the organizer screen). The
 * orchestrator in `scanPages.ts` owns mounting + the fallback chain.
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
  // Chain mode: while on, each new shot continues the previous shot's recipe.
  // The marker is carried through to the organizer, which pre-merges these
  // pages (and lets the user un-merge them). One tap per multi-page recipe.
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
      // *visible* viewport; `overflow-hidden` + the strict shrink-0 / flex-1
      // min-h-0 column below guarantees the shutter never lands under the home
      // indicator no matter the device height.
      className="fixed left-0 top-0 z-50 flex h-[100dvh] w-screen flex-col overflow-hidden bg-stone-950 text-white"
    >
      <canvas ref={canvasRef} className="hidden" aria-hidden />

      <header
        className={`flex shrink-0 items-center justify-between gap-2 py-3 text-sm ${SAFE_TOP} ${SAFE_X}`}
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

      <div className="relative min-h-0 flex-1 overflow-hidden">
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

        {/* Chain-on hint — an overlay so toggling it never reflows the column. */}
        {chainNext && (
          <div
            className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-sky-600/90 px-3 py-1 text-center text-xs"
            aria-live="polite"
          >
            ⛓ Chain on — next photo joins this recipe
          </div>
        )}

        {/* Captured-pages strip — overlaid along the bottom of the preview so
            it doesn't consume column height. Tap × to remove a shot. */}
        {shots.length > 0 && (
          <div
            className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-stone-950/80 to-transparent px-2 pb-2 pt-8 ${SAFE_X}`}
          >
            <ol className="flex gap-2 overflow-x-auto">
              {shots.map((s, i) => {
                const isCont = s.marker.joinsPrevious && i > 0;
                return (
                  <li key={s.id} className="relative shrink-0 pr-1 pt-1">
                    <div
                      className={`h-16 w-12 overflow-hidden rounded ring-2 ${
                        isCont ? 'ring-sky-500' : 'ring-white/40'
                      }`}
                    >
                      <img
                        src={s.url}
                        alt={ariaForShot(i, s.marker)}
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    </div>
                    {isCont && (
                      <span
                        className="absolute left-0 top-1 bg-sky-600/90 px-1 text-[10px] leading-tight"
                        aria-hidden
                      >
                        ⛓
                      </span>
                    )}
                    <span className="absolute bottom-0 left-0 right-1 bg-stone-950/70 text-center text-[10px] leading-tight text-stone-100">
                      {i + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => remove(s.id)}
                      aria-label={`Remove page ${i + 1}`}
                      className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center rounded-full bg-stone-900/90 text-xs leading-none text-white shadow ring-1 ring-white/30"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>

      <div className={`grid shrink-0 grid-cols-3 items-center py-3 ${SAFE_BOTTOM} ${SAFE_X}`}>
        <button
          type="button"
          role="switch"
          aria-checked={chainNext}
          aria-label="Chain mode: each new photo continues the previous recipe"
          onClick={() => setChainNext((v) => !v)}
          className={`inline-flex items-center justify-center justify-self-start rounded-full ${TAP_TARGET} ${
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
          className="h-16 w-16 justify-self-center rounded-full border-4 border-white bg-white/90 shadow-lg disabled:opacity-40 sm:h-20 sm:w-20"
        />
        <span aria-hidden />
      </div>
    </div>
  );
}
