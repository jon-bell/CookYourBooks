// Thin wrapper around Wave 2c's `./multiShotCamera.ts`. Kept as a
// separate module so we can swap the real implementation for a stub
// in tests, and so a future build can re-introduce a dynamic-import
// fallback if the camera module moves out of the web bundle.

import {
  captureMultiShot as captureMultiShotImpl,
  isMultiShotAvailable as isMultiShotAvailableImpl,
} from './multiShotCamera.js';

export function isMultiShotAvailable(): Promise<boolean> {
  try {
    return Promise.resolve(isMultiShotAvailableImpl());
  } catch {
    return Promise.resolve(false);
  }
}

export async function captureMultiShot(opts?: { maxShots?: number }): Promise<File[]> {
  try {
    return await captureMultiShotImpl(opts);
  } catch {
    return [];
  }
}
