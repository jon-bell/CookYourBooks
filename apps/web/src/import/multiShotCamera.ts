import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { MultiShotCameraDialog, type MultiShotCameraDialogProps } from './MultiShotCameraDialog.js';

const DEFAULT_MAX_SHOTS = 200;
const DEFAULT_JPEG_QUALITY = 0.85;

export class CancelledError extends Error {
  override name = 'CancelledError';
  constructor(message = 'cancelled') {
    super(message);
  }
}

export class PermissionDeniedError extends Error {
  override name = 'PermissionDeniedError';
  constructor(message = 'permission-denied') {
    super(message);
  }
}

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
};

function getCapacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function isMultiShotAvailable(): boolean {
  const cap = getCapacitor();
  if (!cap?.isNativePlatform?.()) return false;
  const platform = cap.getPlatform?.();
  if (platform !== 'ios' && platform !== 'android') return false;
  if (typeof cap.isPluginAvailable === 'function' && !cap.isPluginAvailable('Camera')) {
    return false;
  }
  return true;
}

export async function captureMultiShot(opts?: {
  maxShots?: number;
  jpegQuality?: number;
}): Promise<File[]> {
  if (!isMultiShotAvailable()) {
    throw new Error('Multi-shot camera is only available on iOS or Android.');
  }

  const maxShots = clampInt(opts?.maxShots ?? DEFAULT_MAX_SHOTS, 1, 1000);
  const jpegQuality = clampQuality(opts?.jpegQuality ?? DEFAULT_JPEG_QUALITY);

  const cameraModule = await import('@capacitor/camera');
  const { Camera, CameraResultType, CameraSource } = cameraModule;

  try {
    const status = await Camera.checkPermissions();
    if (status.camera !== 'granted' && status.camera !== 'limited') {
      const req = await Camera.requestPermissions({ permissions: ['camera'] });
      if (req.camera !== 'granted' && req.camera !== 'limited') {
        throw new PermissionDeniedError();
      }
    }
  } catch (err) {
    if (err instanceof PermissionDeniedError) throw err;
    throw new PermissionDeniedError((err as Error)?.message ?? 'permission-denied');
  }

  return new Promise<File[]>((resolve, reject) => {
    const onShutter = async (): Promise<File | undefined> => {
      try {
        const photo = await Camera.getPhoto({
          source: CameraSource.Camera,
          resultType: CameraResultType.Base64,
          quality: Math.round(jpegQuality * 100),
          allowEditing: false,
          correctOrientation: true,
          saveToGallery: false,
        });
        if (!photo.base64String) return undefined;
        const blob = base64ToBlob(photo.base64String, mimeForFormat(photo.format));
        return new File([blob], '', { type: blob.type });
      } catch (err) {
        if (isCancellation(err)) return undefined;
        throw err;
      }
    };

    mountDialog({
      maxShots,
      onShutter,
      onDone: (files) => {
        resolve(renameSequential(files));
      },
      onCancel: () => {
        reject(new CancelledError());
      },
    });
  });
}

function mountDialog(props: MultiShotCameraDialogProps): void {
  const host = document.createElement('div');
  host.setAttribute('data-multi-shot-camera-root', '');
  document.body.appendChild(host);
  const root = createRoot(host);

  const cleanup = () => {
    queueMicrotask(() => {
      root.unmount();
      if (host.parentNode) host.parentNode.removeChild(host);
    });
  };

  const wrapped: MultiShotCameraDialogProps = {
    ...props,
    onDone: (files) => {
      try {
        props.onDone(files);
      } finally {
        cleanup();
      }
    },
    onCancel: () => {
      try {
        props.onCancel();
      } finally {
        cleanup();
      }
    },
  };

  root.render(createElement(MultiShotCameraDialog, wrapped));
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function mimeForFormat(format: string | undefined): string {
  if (!format) return 'image/jpeg';
  const fmt = format.toLowerCase();
  if (fmt === 'jpeg' || fmt === 'jpg') return 'image/jpeg';
  if (fmt === 'png') return 'image/png';
  if (fmt === 'webp') return 'image/webp';
  if (fmt === 'heic' || fmt === 'heif') return 'image/heic';
  return `image/${fmt}`;
}

function renameSequential(files: File[]): File[] {
  return files.map((f, i) => {
    const ext = extensionFor(f.type);
    const name = `cookbook-${String(i + 1).padStart(3, '0')}.${ext}`;
    return new File([f], name, { type: f.type, lastModified: f.lastModified });
  });
}

function extensionFor(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic' || mime === 'image/heif') return 'heic';
  return 'jpg';
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.round(n), min), max);
}

function clampQuality(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_JPEG_QUALITY;
  return Math.min(Math.max(n, 0.1), 1);
}

function isCancellation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as { message?: string }).message ?? '');
  return /cancel|denied|user cancelled|no image/i.test(msg);
}
