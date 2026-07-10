import { useCallback, useEffect, useRef, useState } from 'react';

import { SAFE_BOTTOM, SAFE_TOP, SAFE_X, TAP_TARGET } from '../components/mobileSafeArea.js';
import { shutterHaptic } from './cameraFeedback.js';
import { DEFAULT_MARKER, type PageKind, type PageMarker, type ScannedPage } from './pageMarker.js';
import { hasSeenScanTutorial, markScanTutorialSeen, ScannerHelpModal } from './ScannerHelpModal.js';
import { isVolumeButtonAvailable, subscribeVolumeButton } from './volumeButton.js';

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
  if (m.kind === 'TOC') parts.push('table of contents');
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
  const stripRef = useRef<HTMLOListElement>(null);
  const lastShotAt = useRef(0);

  const [shots, setShots] = useState<Shot[]>([]);
  const [status, setStatus] = useState<Status>('starting');
  const [errorMsg, setErrorMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  // Brief white flash + shutter pulse on each capture — a clear visual
  // confirmation the shot landed (pairs with the haptic).
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 140);
    return () => clearTimeout(t);
  }, [flash]);

  // Keep the newest captured thumbnail in view as the strip grows.
  useEffect(() => {
    stripRef.current?.scrollTo({ left: stripRef.current.scrollWidth, behavior: 'smooth' });
  }, [shots.length]);

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

  const capture = useCallback(
    async (opts: { join?: boolean; kind?: PageKind } = {}) => {
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
            marker: {
              kind: opts.kind ?? DEFAULT_MARKER.kind,
              // A leading join (no predecessor) is meaningless; planPageGroups
              // makes it its own leader anyway, but keep the flag honest.
              joinsPrevious: !!opts.join && prev.length > 0,
            },
          },
        ]);
        setFlash(true);
        void shutterHaptic();
      } finally {
        setBusy(false);
      }
    },
    [busy, shots.length, maxShots, captureFrame],
  );

  // Hardware volume buttons fire the shutter on iOS: volume-up captures AND
  // chains to the last page (multi-page recipe), volume-down is the plain
  // shutter. Subscribe once while the camera is live; a ref carries the latest
  // `capture` so a new shot doesn't re-subscribe (which would churn the native
  // audio session).
  const captureRef = useRef(capture);
  useEffect(() => {
    captureRef.current = capture;
  }, [capture]);
  useEffect(() => {
    if (status !== 'live') return;
    return subscribeVolumeButton((direction) =>
      direction === 'up' ? void captureRef.current({ join: true }) : void captureRef.current(),
    );
  }, [status]);

  // First-launch tutorial: starts open on a fresh device (render is gated on
  // the camera being live, so it never covers an error screen) and is marked
  // seen on dismiss; the header's "?" button reopens it any time without
  // re-arming the localStorage gate.
  const [showHelp, setShowHelp] = useState(() => !hasSeenScanTutorial());
  function dismissHelp() {
    markScanTutorialSeen();
    setShowHelp(false);
  }

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
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowHelp(true)}
            aria-label="Scanner help"
            className={`inline-flex items-center justify-center rounded-full text-stone-200 hover:bg-stone-800 ${TAP_TARGET}`}
          >
            <span aria-hidden className="text-lg leading-none">
              ?
            </span>
          </button>
          <button
            type="button"
            onClick={done}
            disabled={shots.length === 0}
            className="rounded-md bg-amber-500 px-3 py-1.5 font-medium text-stone-950 disabled:opacity-40"
          >
            Done
          </button>
        </div>
      </header>

      {isLive && showHelp && (
        <ScannerHelpModal showVolumeButtons={isVolumeButtonAvailable()} onDismiss={dismissHelp} />
      )}

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

        {/* Shutter flash — inline style keeps the white out of the dark-mode
            class guard while still fading via the transition. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 transition-opacity duration-150"
          style={{ backgroundColor: 'white', opacity: flash ? 0.7 : 0 }}
        />

        {/* Captured-pages strip — overlaid along the bottom of the preview so
            it doesn't consume column height. Tap × to remove a shot. */}
        {shots.length > 0 && (
          <div
            className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-stone-950/80 to-transparent px-2 pb-2 pt-8 ${SAFE_X}`}
          >
            <ol ref={stripRef} className="flex gap-2 overflow-x-auto">
              {shots.map((s, i) => {
                const isCont = s.marker.joinsPrevious && i > 0;
                const isToc = s.marker.kind === 'TOC';
                return (
                  <li key={s.id} className="relative shrink-0 pr-1 pt-1">
                    <div
                      className={`h-16 w-12 overflow-hidden rounded ring-2 ${
                        isToc ? 'ring-amber-400' : isCont ? 'ring-sky-500' : 'ring-white/40'
                      }`}
                    >
                      <img
                        src={s.url}
                        alt={ariaForShot(i, s.marker)}
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    </div>
                    {isCont ? (
                      <span
                        className="absolute left-0 top-1 bg-sky-600/90 px-1 text-[10px] leading-tight"
                        aria-hidden
                      >
                        ⛓
                      </span>
                    ) : isToc ? (
                      <span
                        className="absolute left-0 top-1 bg-amber-500/90 px-1 text-[10px] leading-tight"
                        aria-hidden
                      >
                        ▤
                      </span>
                    ) : null}
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
        {/* Variant: capture + continue the previous recipe (multi-page). */}
        <div className="flex flex-col items-center gap-1 justify-self-start">
          <button
            type="button"
            onClick={() => void capture({ join: true })}
            disabled={!isLive || busy || shots.length === 0}
            aria-label="Capture and join to the previous page"
            className={`inline-flex items-center justify-center rounded-full border-2 border-sky-400/70 bg-stone-800/70 text-lg text-white disabled:opacity-30 ${TAP_TARGET}`}
          >
            <span aria-hidden>⛓</span>
          </button>
          <span className="text-[10px] text-white/70">Join</span>
        </div>
        {/* Default shutter: a new recipe page. */}
        <button
          type="button"
          onClick={() => void capture()}
          disabled={!isLive || busy}
          aria-label="Capture page"
          className={`h-16 w-16 justify-self-center rounded-full border-4 border-white bg-white/90 shadow-lg transition-transform active:scale-95 disabled:opacity-40 sm:h-20 sm:w-20 ${
            flash ? 'scale-90' : 'scale-100'
          }`}
        />
        {/* Variant: capture + mark as a table-of-contents page. */}
        <div className="flex flex-col items-center gap-1 justify-self-end">
          <button
            type="button"
            onClick={() => void capture({ kind: 'TOC' })}
            disabled={!isLive || busy}
            aria-label="Capture as a table-of-contents page"
            className={`inline-flex items-center justify-center rounded-full border-2 border-amber-400/70 bg-stone-800/70 text-lg text-white disabled:opacity-30 ${TAP_TARGET}`}
          >
            <span aria-hidden>▤</span>
          </button>
          <span className="text-[10px] text-white/70">Contents</span>
        </div>
      </div>
    </div>
  );
}
