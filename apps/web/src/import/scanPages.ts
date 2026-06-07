import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CameraScanner, type CameraScannerProps } from './CameraScanner.js';
import { captureMultiShot, isMultiShotAvailable } from './multiShotShim.js';

export interface ScanOptions {
  maxShots?: number;
  jpegQuality?: number;
}

/** Thrown internally when the live camera is unusable so `scanPages` knows
 *  to fall through to the OS-camera / web-input fallback rather than abort. */
class LiveUnavailableError extends Error {
  override name = 'LiveUnavailableError';
}

declare global {
  interface Window {
    /** E2E hook: short-circuits the live camera with canned Files.
     *  Mirrors `window.__cybPlannerShutter` (see plannerCapture.ts). */
    __cybScanShim?: (opts?: ScanOptions) => Promise<File[]>;
    /** Manual/debug escape hatch to force the OS-camera/web fallback. */
    __cybDisableLiveScan?: boolean;
  }
}

export function isLiveViewfinderSupported(): boolean {
  if (typeof window !== 'undefined' && window.__cybDisableLiveScan) return false;
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

/**
 * Capture a stack of page photos for import. Resolution order:
 *   1. `window.__cybScanShim` — deterministic E2E hook.
 *   2. the live getUserMedia viewfinder ({@link CameraScanner}) — the default
 *      smooth rapid-fire experience on phones + the desktop webcam.
 *   3. the native Capacitor multi-shot camera (OS-camera loop).
 *   4. a plain web `<input type=file multiple>` picker.
 * Returns `[]` if the user cancels with nothing captured.
 */
export async function scanPages(opts?: ScanOptions): Promise<File[]> {
  if (typeof window !== 'undefined' && window.__cybScanShim) {
    return renameSequential(await window.__cybScanShim(opts));
  }
  if (isLiveViewfinderSupported()) {
    try {
      return renameSequential(await mountScanner(opts));
    } catch (err) {
      if (!(err instanceof LiveUnavailableError)) throw err;
      // Permission denied / user chose the system camera → fall through.
    }
  }
  if (await isMultiShotAvailable()) {
    return captureMultiShot(opts);
  }
  return renameSequential(await pickFilesWeb());
}

function mountScanner(opts?: ScanOptions): Promise<File[]> {
  return new Promise<File[]>((resolve, reject) => {
    const host = document.createElement('div');
    host.setAttribute('data-camera-scanner-root', '');
    document.body.appendChild(host);
    let root: Root | undefined;
    const cleanup = () => {
      queueMicrotask(() => {
        root?.unmount();
        if (host.parentNode) host.parentNode.removeChild(host);
      });
    };
    const props: CameraScannerProps = {
      maxShots: opts?.maxShots,
      jpegQuality: opts?.jpegQuality,
      onDone: (files) => {
        try {
          resolve(files);
        } finally {
          cleanup();
        }
      },
      onCancel: () => {
        try {
          resolve([]);
        } finally {
          cleanup();
        }
      },
      onFallback: () => {
        try {
          reject(new LiveUnavailableError());
        } finally {
          cleanup();
        }
      },
    };
    root = createRoot(host);
    root.render(createElement(CameraScanner, props));
  });
}

async function pickFilesWeb(): Promise<File[]> {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    const cleanup = () => {
      if (input.parentNode) document.body.removeChild(input);
    };
    input.addEventListener('change', () => {
      const files = input.files ? Array.from(input.files) : [];
      cleanup();
      resolve(files);
    });
    input.addEventListener('cancel', () => {
      cleanup();
      resolve([]);
    });
    document.body.appendChild(input);
    input.click();
  });
}

function renameSequential(files: File[]): File[] {
  return files.map((f, i) => {
    const ext = f.type === 'image/png' ? 'png' : f.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([f], `scan-${String(i + 1).padStart(3, '0')}.${ext}`, {
      type: f.type || 'image/jpeg',
      lastModified: f.lastModified,
    });
  });
}
