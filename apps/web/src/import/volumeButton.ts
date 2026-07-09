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
  remove: () => Promise<void>;
}

interface VolumeButtonPlugin {
  /** Begin observing volume presses (activates a silent audio session). */
  startListening: () => Promise<void>;
  /** Stop observing (releases the audio session). */
  stopListening: () => Promise<void>;
  addListener: (eventName: 'volumePressed', listener: () => void) => Promise<PluginListenerHandle>;
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
  void plugin
    .addListener('volumePressed', onPress)
    .then((h) => {
      handle = h;
      // If we were torn down before the listener resolved, remove it now.
      if (removed) void h.remove().catch(() => {});
    })
    .catch(() => {});

  return () => {
    removed = true;
    void handle?.remove().catch(() => {});
    void plugin.stopListening().catch(() => {});
  };
}
