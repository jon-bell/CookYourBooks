import { useRef, useState } from 'react';

type Transform = { x: number; y: number; scale: number };

interface Props {
  src: string;
  alt: string;
  className?: string;
  /** Tightest zoom-out allowed. Default 0.5×. */
  minScale?: number;
  /** Loosest zoom-in allowed. Default 8×. */
  maxScale?: number;
  /** Object-fit for the underlying `<img>`. Default `'contain'`. */
  objectFit?: 'contain' | 'cover';
}

/**
 * An `<img>` wrapped in mouse + touch + wheel zoom/pan handlers. Two-finger
 * pinch on touch devices; ctrl/cmd + wheel scroll on desktop; click-drag or
 * one-finger-drag to pan; double-click / double-tap to reset.
 *
 * touch-action: none stops the WebView from interpreting two-finger gestures
 * as page-level pinch — without it iOS would scale the surrounding page
 * instead of the image, which is what produced the original "can't pinch in
 * import mode" report.
 */
export function PinchPanImage({
  src,
  alt,
  className,
  minScale = 0.5,
  maxScale = 8,
  objectFit = 'contain',
}: Props) {
  const [t, setT] = useState<Transform>({ x: 0, y: 0, scale: 1 });

  // Active gesture state lives in a ref so the React state only updates
  // with the final transform, not on every pointer move.
  const gesture = useRef<{
    kind: 'mouse' | 'touch-1' | 'touch-2';
    startX: number;
    startY: number;
    startT: Transform;
    /** For pinch only: initial distance between the two fingers. */
    startDist?: number;
  } | null>(null);

  function clampScale(n: number) {
    return Math.max(minScale, Math.min(maxScale, n));
  }

  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setT((prev) => ({
      ...prev,
      scale: clampScale(prev.scale + (e.deltaY < 0 ? 0.15 : -0.15)),
    }));
  }

  function onDoubleClick() {
    setT({ x: 0, y: 0, scale: 1 });
  }

  function onMouseDown(e: React.MouseEvent) {
    gesture.current = {
      kind: 'mouse',
      startX: e.clientX,
      startY: e.clientY,
      startT: t,
    };
  }
  function onMouseMove(e: React.MouseEvent) {
    if (gesture.current?.kind !== 'mouse') return;
    setT({
      ...gesture.current.startT,
      x: gesture.current.startT.x + (e.clientX - gesture.current.startX),
      y: gesture.current.startT.y + (e.clientY - gesture.current.startY),
    });
  }
  function onMouseUp() {
    if (gesture.current?.kind === 'mouse') gesture.current = null;
  }

  function midpoint(a: React.Touch, b: React.Touch) {
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }
  function dist(a: React.Touch, b: React.Touch) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function onTouchStart(e: React.TouchEvent) {
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    if (e.touches.length === 1 && t0) {
      gesture.current = {
        kind: 'touch-1',
        startX: t0.clientX,
        startY: t0.clientY,
        startT: t,
      };
    } else if (e.touches.length === 2 && t0 && t1) {
      const m = midpoint(t0, t1);
      gesture.current = {
        kind: 'touch-2',
        startX: m.x,
        startY: m.y,
        startT: t,
        startDist: dist(t0, t1),
      };
    }
  }
  function onTouchMove(e: React.TouchEvent) {
    if (!gesture.current) return;
    e.preventDefault();
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    if (gesture.current.kind === 'touch-1' && e.touches.length === 1 && t0) {
      setT({
        ...gesture.current.startT,
        x: gesture.current.startT.x + (t0.clientX - gesture.current.startX),
        y: gesture.current.startT.y + (t0.clientY - gesture.current.startY),
      });
    } else if (
      gesture.current.kind === 'touch-2' &&
      e.touches.length === 2 &&
      t0 &&
      t1 &&
      gesture.current.startDist
    ) {
      const m = midpoint(t0, t1);
      const ratio = dist(t0, t1) / gesture.current.startDist;
      setT({
        scale: clampScale(gesture.current.startT.scale * ratio),
        x: gesture.current.startT.x + (m.x - gesture.current.startX),
        y: gesture.current.startT.y + (m.y - gesture.current.startY),
      });
    }
  }
  function onTouchEnd(e: React.TouchEvent) {
    // If the user lifts one finger of a pinch, re-seed as a one-finger pan
    // so the image doesn't jump. Otherwise end the gesture entirely.
    const remaining = e.touches[0];
    if (e.touches.length === 0) gesture.current = null;
    else if (e.touches.length === 1 && remaining && gesture.current?.kind === 'touch-2') {
      gesture.current = {
        kind: 'touch-1',
        startX: remaining.clientX,
        startY: remaining.clientY,
        startT: t,
      };
    }
  }

  return (
    <div
      className={className}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onDoubleClick={onDoubleClick}
      style={{ touchAction: 'none', overflow: 'hidden', cursor: 'grab' }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="absolute inset-0 h-full w-full select-none"
        style={{
          objectFit,
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          transformOrigin: 'center',
        }}
      />
    </div>
  );
}
