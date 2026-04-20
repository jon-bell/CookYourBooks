import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.jonbell.cookyourbooks',
  appName: 'CookYourBooks',
  // The web app is built into ../web/dist; Capacitor copies that into the
  // native project on `cap sync`.
  webDir: '../web/dist',
  ios: {
    // ATS: allow localhost traffic during development so the app can reach
    // local Supabase. Production builds should remove this — see README.
    allowsLinkPreview: true,
  },
  android: {
    // Allow cleartext so the development build can hit local Supabase over
    // http on LAN. Set to false before shipping.
    allowMixedContent: true,
  },
  plugins: {
    Camera: {
      // Quality and permissions are configured per-capture via the plugin's
      // options object — no global overrides needed here.
    },
  },
};

export default config;
