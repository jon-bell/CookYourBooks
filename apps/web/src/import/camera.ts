// Cross-platform capture. On Capacitor (native), uses the Camera plugin.
// On web, prompts for a file via a hidden <input type="file" capture> —
// mobile browsers surface the camera; desktop browsers fall back to the
// system file picker.

/** Returns a Blob+name the OCR pipeline can consume, or undefined if the
 *  user cancelled. */
export async function capturePhoto(): Promise<{ blob: Blob; name: string } | undefined> {
  if (isCapacitorNative()) return captureNative();
  return captureWeb({ preferCamera: true });
}

/**
 * Pick an existing image from the device library / file system. On
 * native this opens the photo picker; on web it drops the `capture`
 * hint so desktop browsers give the user the full file system.
 */
export async function pickPhoto(): Promise<{ blob: Blob; name: string } | undefined> {
  if (isCapacitorNative()) return pickNative();
  return captureWeb({ preferCamera: false });
}

function isCapacitorNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

async function captureNative(): Promise<{ blob: Blob; name: string } | undefined> {
  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Camera,
      quality: 85,
      allowEditing: false,
      correctOrientation: true,
    });
    if (!photo.dataUrl) return undefined;
    const blob = await dataUrlToBlob(photo.dataUrl);
    return { blob, name: `capture.${photo.format ?? 'jpg'}` };
  } catch (err) {
    // User cancellation surfaces as a rejected promise on some platforms.
    if (isCancellation(err)) return undefined;
    throw err;
  }
}

async function pickNative(): Promise<{ blob: Blob; name: string } | undefined> {
  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Photos,
      quality: 85,
      allowEditing: false,
      correctOrientation: true,
    });
    if (!photo.dataUrl) return undefined;
    const blob = await dataUrlToBlob(photo.dataUrl);
    return { blob, name: `upload.${photo.format ?? 'jpg'}` };
  } catch (err) {
    if (isCancellation(err)) return undefined;
    throw err;
  }
}

async function captureWeb(
  opts: { preferCamera: boolean },
): Promise<{ blob: Blob; name: string } | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (opts.preferCamera) {
      // Mobile-browser hint; desktop ignores it. We only set it for
      // the "take a photo" path so "upload" on desktop opens the full
      // file system and on mobile web opens the gallery by default.
      input.setAttribute('capture', 'environment');
    }
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) resolve(undefined);
      else resolve({ blob: file, name: file.name });
    });
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      resolve(undefined);
    });
    document.body.appendChild(input);
    input.click();
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const resp = await fetch(dataUrl);
  return resp.blob();
}

function isCancellation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as { message?: string }).message ?? '');
  return /cancel|denied|permission/i.test(msg);
}
