// One-shot-at-a-time capture for the Speed Importer.
//
// Why not reuse `multiShotCamera.ts`? That dialog accumulates Files in
// JS state and only resolves on the user's "Done" tap — fine for the
// one-shot /import/new wizard, wrong for an async-resumable planner
// session where every shutter should be durably uploaded before the
// app can be backgrounded. The planner drives the loop itself instead;
// each tap of the in-app shutter calls `plannerShutter()` exactly
// once, the result is uploaded immediately, and only then does the UI
// invite the next shot.
//
// Bridge cost matters on iOS: we use `resultType: Uri` (file stays on
// disk, JS sees a webPath) and fetch the Blob lazily. Base64 round-
// trips through the Capacitor bridge run ~1.5MB per shot and warm the
// device — the planner avoids them.

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

function getCapacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

function isNative(): boolean {
  return !!getCapacitor()?.isNativePlatform?.();
}

declare global {
  interface Window {
    /**
     * E2E hook: replace the real shutter with a function that hands
     * back canned Files. Tests use this to drive the planner without
     * a camera or filechooser interaction.
     */
    __cybPlannerShutter?: () => Promise<File | undefined>;
  }
}

/**
 * Take one photo. Returns a File suitable for `prepareImage`, or
 * undefined if the user cancelled. On native iOS/Android this opens
 * the Capacitor Camera plugin (Uri result type — cheap on bridge).
 * On web it falls back to a hidden `<input type="file" capture>` so
 * desktop devs can exercise the flow.
 */
export async function plannerShutter(): Promise<File | undefined> {
  if (typeof window !== 'undefined' && window.__cybPlannerShutter) {
    return window.__cybPlannerShutter();
  }
  if (isNative()) return shutterNative();
  return shutterWeb();
}

async function shutterNative(): Promise<File | undefined> {
  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
    const photo = await Camera.getPhoto({
      source: CameraSource.Camera,
      resultType: CameraResultType.Uri,
      quality: 85,
      allowEditing: false,
      correctOrientation: true,
      saveToGallery: false,
    });
    const path = photo.webPath ?? photo.path;
    if (!path) return undefined;
    const resp = await fetch(path);
    const blob = await resp.blob();
    const ext = (photo.format ?? 'jpg').toLowerCase();
    return new File([blob], `shot-${Date.now()}.${ext}`, {
      type: blob.type || mimeFor(ext),
    });
  } catch (err) {
    if (isCancellation(err)) return undefined;
    throw err;
  }
}

async function shutterWeb(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    // Mobile-browser hint; desktop ignores it. Setting `environment`
    // asks for the rear camera when the browser does honor it.
    input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    const cleanup = () => {
      if (input.parentNode) document.body.removeChild(input);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      cleanup();
      resolve(file ?? undefined);
    });
    input.addEventListener('cancel', () => {
      cleanup();
      resolve(undefined);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Light haptic feedback after a successful capture+upload. Best-effort
 * — silently no-ops on web or when the plugin isn't available. Helps
 * the iOS shooting loop feel snappy without visual flicker.
 */
export async function plannerHapticTick(): Promise<void> {
  if (!isNative()) return;
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // ignored — haptics are a nicety, not a requirement
  }
}

function mimeFor(ext: string): string {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return `image/${ext}`;
}

function isCancellation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as { message?: string }).message ?? '');
  return /cancel|denied|user cancelled|no image/i.test(msg);
}
