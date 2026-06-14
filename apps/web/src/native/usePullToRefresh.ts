import { useEffect } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import type { PullToRefreshPlugin } from 'capacitor-native-pull-to-refresh';
import { useSync } from '../local/SyncProvider.js';

/**
 * Wire native iOS pull-to-refresh to a sync.
 *
 * The app scrolls at the window/webview level (a single scroll container), which
 * is exactly what `capacitor-native-pull-to-refresh`'s `UIRefreshControl` binds
 * to — so enabling it once at the app shell covers every page. The plugin is
 * iOS-only; everywhere else (web, Android, or a native build without the pod)
 * the dynamic import / feature-detect makes this a clean no-op.
 *
 * On a pull, we drain the sync (`syncNow()` already coalesces overlapping calls)
 * and dismiss the native spinner when it settles.
 */
function isIosNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } })
    .Capacitor;
  return !!cap?.isNativePlatform?.() && cap?.getPlatform?.() === 'ios';
}

export function usePullToRefresh(): void {
  const { syncNow } = useSync();

  useEffect(() => {
    if (!isIosNative()) return;

    let disposed = false;
    let busy = false;
    let listener: PluginListenerHandle | undefined;
    let plugin: PullToRefreshPlugin | undefined;

    void (async () => {
      try {
        const mod = await import('capacitor-native-pull-to-refresh');
        if (disposed) return;
        plugin = mod.PullToRefresh;
        await plugin.enable();
        // 'state' fires for both refreshing:true (pull released) and
        // refreshing:false (spinner dismissed) — only act on the rising edge,
        // and guard against overlapping syncs.
        listener = await plugin.addListener('state', ({ refreshing }) => {
          if (!refreshing || busy || !plugin) return;
          busy = true;
          void syncNow().finally(() => {
            busy = false;
            void plugin?.endRefreshing().catch(() => {});
          });
        });
      } catch {
        // Plugin absent / not registered (web, Android, or native build without
        // the pod installed) — pull-to-refresh simply isn't available here.
      }
    })();

    return () => {
      disposed = true;
      void listener?.remove();
      void plugin?.disable().catch(() => {});
    };
  }, [syncNow]);
}
