import { afterEach, describe, expect, it, vi } from 'vitest';

import { subscribeVolumeButton } from './volumeButton.js';

type Listener = () => void;

type GlobalWithCapacitor = typeof globalThis & {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    Plugins?: Record<string, unknown>;
  };
};

const g = globalThis as GlobalWithCapacitor;

/** Drain the microtask queue (addListener resolution + removeHandle deferral). */
const flush = () => new Promise((res) => setTimeout(res, 0));

afterEach(() => {
  delete g.Capacitor;
});

/**
 * Install a fake CybVolumeButton plugin. `handleMode` controls whether
 * `addListener` returns the handle synchronously — the legacy
 * `Capacitor.Plugins.*` proxy shape that caused CYB-CAPACITOR-1Q — or wrapped
 * in a Promise, the modern `registerPlugin` proxy shape.
 */
function installPlugin(handleMode: 'sync' | 'promise') {
  const remove = vi.fn(() => undefined); // legacy handle: `remove` returns void
  let captured: Listener | undefined;
  const addListener = vi.fn((_event: string, listener: Listener) => {
    captured = listener;
    const handle = { remove };
    return handleMode === 'sync' ? handle : Promise.resolve(handle);
  });
  const plugin = {
    startListening: vi.fn(() => Promise.resolve()),
    stopListening: vi.fn(() => Promise.resolve()),
    addListener,
  };
  g.Capacitor = {
    isNativePlatform: () => true,
    Plugins: { CybVolumeButton: plugin },
  };
  return { plugin, remove, fire: () => captured?.() };
}

describe('subscribeVolumeButton', () => {
  it('is a no-op on web (no Capacitor global)', () => {
    const unsub = subscribeVolumeButton(vi.fn());
    expect(() => unsub()).not.toThrow();
  });

  it('is a no-op when native but the plugin is not registered', () => {
    g.Capacitor = { isNativePlatform: () => true, Plugins: {} };
    const unsub = subscribeVolumeButton(vi.fn());
    expect(() => unsub()).not.toThrow();
  });

  // Regression: the legacy proxy hands back the handle synchronously, so the
  // old `addListener(...).then(...)` threw "addListener(...).then is not a
  // function" the instant the camera went live (CYB-CAPACITOR-1Q).
  it('does not throw when addListener returns the handle synchronously', () => {
    const { plugin } = installPlugin('sync');
    expect(() => subscribeVolumeButton(vi.fn())).not.toThrow();
    expect(plugin.startListening).toHaveBeenCalledTimes(1);
    expect(plugin.addListener).toHaveBeenCalledWith('volumePressed', expect.any(Function));
  });

  it('fires onPress when the native event fires (sync handle)', () => {
    const { fire } = installPlugin('sync');
    const onPress = vi.fn();
    subscribeVolumeButton(onPress);
    fire();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('removes the listener and stops listening on unsubscribe (sync handle)', async () => {
    const { plugin, remove } = installPlugin('sync');
    subscribeVolumeButton(vi.fn())();
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(plugin.stopListening).toHaveBeenCalledTimes(1);
  });

  it('also works when addListener returns a Promise (modern proxy)', async () => {
    const { plugin, remove, fire } = installPlugin('promise');
    const onPress = vi.fn();
    const unsub = subscribeVolumeButton(onPress);
    await flush();
    fire();
    expect(onPress).toHaveBeenCalledTimes(1);
    unsub();
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(plugin.stopListening).toHaveBeenCalledTimes(1);
  });

  it('removes the listener even when torn down before the promise resolves', async () => {
    const { remove } = installPlugin('promise');
    // Unsubscribe synchronously, before the addListener promise has resolved.
    subscribeVolumeButton(vi.fn())();
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
