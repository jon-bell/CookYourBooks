// Reads a file shared into CookYourBooks from another app. The native iOS
// share extension copies the shared file (PDF / image) into the app group
// container and hands the JS layer a `file://` path (via the share intent).
// The bytes can't cross the deep link (too big), so we read them on demand
// through a tiny custom Capacitor plugin, `CybFile`, which resolves the app
// group container, reads the file, and returns base64. We wrap that as a
// browser `File` so the rest of the import pipeline (`renderPdfToJpegs`,
// `extractSourceUrlFromPdf`, …) can consume it unchanged.
//
// Native-only: there is no app-group `file://` share on the web, so the web
// build throws a clear error if ever asked. We talk to the plugin through the
// global `Capacitor.Plugins` registry rather than importing an npm package —
// same runtime-feature-detection posture as `shareIntent.ts` / `camera.ts`.

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  // deno-lint-ignore no-explicit-any
  Plugins?: Record<string, any>;
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

interface CybFilePlugin {
  readSharedFile(opts: { url: string }): Promise<{
    base64?: string;
    mimeType?: string;
    name?: string;
  }>;
}

function cybFile(): CybFilePlugin | undefined {
  const plugin = capacitor()?.Plugins?.CybFile as CybFilePlugin | undefined;
  return typeof plugin?.readSharedFile === 'function' ? plugin : undefined;
}

/** True when the native shared-file bridge is present (native build only). */
export function isSharedFileBridgeAvailable(): boolean {
  return !!cybFile();
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  // Back with a concrete ArrayBuffer so the result is a valid BlobPart for the
  // File ctor (TS treats Uint8Array<ArrayBufferLike> as non-assignable).
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function fileNameFromUrl(fileUrl: string): string {
  try {
    const last = fileUrl.split('/').pop() ?? '';
    const decoded = decodeURIComponent(last);
    // App-group copies are prefixed with a UUID — strip it for a friendlier
    // name, but keep the original if there's no underscore.
    const underscore = decoded.indexOf('_');
    return underscore > 0 ? decoded.slice(underscore + 1) : decoded || 'shared';
  } catch {
    return 'shared';
  }
}

function guessMime(fileUrl: string): string {
  const lower = fileUrl.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.heif')) return 'image/heif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

/**
 * Read a shared `file://` attachment from the app group container and return
 * it as a browser `File`. Throws on the web (no native bridge) or when the
 * file can't be read. The native plugin deletes the app-group copy after a
 * successful read.
 */
export async function readSharedFile(
  fileUrl: string,
  opts: { name?: string; mimeType?: string } = {},
): Promise<File> {
  const plugin = cybFile();
  if (!plugin) {
    throw new Error('Shared-file bridge unavailable (not a native build).');
  }
  const res = await plugin.readSharedFile({ url: fileUrl });
  if (!res?.base64) {
    throw new Error('Shared file was empty or could not be read.');
  }
  const bytes = base64ToBytes(res.base64);
  const mimeType = opts.mimeType ?? res.mimeType ?? guessMime(fileUrl);
  const name = opts.name ?? res.name ?? fileNameFromUrl(fileUrl);
  return new File([bytes], name, { type: mimeType });
}
