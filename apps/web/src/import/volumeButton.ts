// Web bridge to the native `CybVolumeButton` iOS plugin (see
// apps/mobile/ios/App/App/CybVolumeButtonPlugin.swift), mirroring the
// `CybFile` bridge in sharedFile.ts. The plugin observes hardware
// volume-button presses (via AVAudioSession output-volume KVO) while the
// camera is open and emits a `volumePressed` event so the shutter can fire
// without touching the screen.
//
// Feature-detected: returns a no-op unsubscribe on the web, on Android, and on
// any native build where the plugin isn't registered — so callers can wire it
// unconditionally.

interface PluginListenerHandle {
  remove: () => void | Promise<void>;
}

interface VolumeButtonPlugin {
  /** Begin observing volume presses (activates a silent audio session). */
  startListening: () => Promise<void>;
  /** Stop observing (releases the audio session). */
  stopListening: () => Promise<void>;
  // Capacitor's legacy `Capacitor.Plugins.*` proxy hands the listener handle
  // back synchronously; the modern `registerPlugin` proxy returns a Promise.
  // Accept both (same shape as useHardwareBack.ts) so callers never assume a
  // thenable — see subscribeVolumeButton.
  addListener: (
    eventName: 'volumePressed',
    listener: () => void,
  ) => PluginListenerHandle | Promise<PluginListenerHandle>;
}

function volumePlugin(): VolumeButtonPlugin | undefined {
  const cap = (
    globalThis as {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        Plugins?: Record<string, unknown>;
      };
    }
  ).Capacitor;
  if (!cap?.isNativePlatform?.()) return undefined;
  const plugin = cap.Plugins?.CybVolumeButton as VolumeButtonPlugin | undefined;
  return typeof plugin?.addListener === 'function' ? plugin : undefined;
}

/** Remove a listener handle, tolerating a sync- or Promise-returning `remove`. */
function removeHandle(handle: PluginListenerHandle | undefined): void {
  if (!handle) return;
  // Defer into a microtask so a synchronously-throwing `remove()` is caught by
  // the `.catch` rather than escaping the caller (e.g. a React cleanup fn).
  void Promise.resolve()
    .then(() => handle.remove())
    .catch(() => {});
}

/**
 * Subscribe to hardware volume-button presses. Returns an unsubscribe function
 * that stops the native observer. No-op (returns a no-op cleanup) when the
 * native plugin is unavailable.
 */
export function subscribeVolumeButton(onPress: () => void): () => void {
  const plugin = volumePlugin();
  if (!plugin) return () => {};

  let removed = false;
  let handle: PluginListenerHandle | undefined;

  void plugin.startListening().catch(() => {});
  // `addListener` may return the handle synchronously (legacy
  // `Capacitor.Plugins.*` proxy) or as a Promise. Normalize with
  // `Promise.resolve` — calling `.then` on the bare handle threw
  // "addListener(...).then is not a function" and crashed the scanner the
  // instant the camera went live (CYB-CAPACITOR-1Q).
  void Promise.resolve(plugin.addListener('volumePressed', onPress))
    .then((h) => {
      handle = h;
      // If we were torn down before the listener resolved, remove it now.
      if (removed) removeHandle(h);
    })
    .catch(() => {});

  return () => {
    removed = true;
    removeHandle(handle);
    void plugin.stopListening().catch(() => {});
  };
}
