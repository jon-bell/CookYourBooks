/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Set only by scripts/ios-screenshots/capture.mjs — compiles in the App Store screenshot driver. */
  readonly VITE_SCREENSHOT_CONTROL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
