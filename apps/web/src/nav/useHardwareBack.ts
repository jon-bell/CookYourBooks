import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    App?: {
      addListener?: (
        event: 'backButton',
        cb: () => void,
      ) => Promise<{ remove: () => void }> | { remove: () => void };
      minimizeApp?: () => void;
    };
  };
}

/**
 * Android hardware/gesture back: navigate the SPA history instead of killing
 * the app. Registering a `backButton` listener disables Capacitor's default
 * (exit) behavior; at the history root we minimize instead, matching what
 * Android users expect from a "home screen" back press. No-op on web/iOS —
 * uses the Capacitor.Plugins registry, so nothing native is imported into
 * the web bundle (same posture as shareIntent.ts).
 */
export function useHardwareBack(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
    if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== 'android') return;
    const appPlugin = cap.Plugins?.App;
    if (!appPlugin?.addListener) return;

    const handle = appPlugin.addListener('backButton', () => {
      // React Router stamps a monotonically-increasing idx per history
      // entry; idx 0 is the entry the app launched on.
      const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
      if (idx > 0) navigate(-1);
      else appPlugin.minimizeApp?.();
    });
    return () => {
      void Promise.resolve(handle).then((h) => h?.remove?.());
    };
  }, [navigate]);
}
