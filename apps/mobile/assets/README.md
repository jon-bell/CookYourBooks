# Mobile assets

Source artwork for app icons and splash screens. `@capacitor/assets`
reads these and emits per-platform sizes into the native Xcode / Gradle
projects.

| File | Purpose |
| ---- | ------- |
| `icon-only.png` | 1024×1024 square icon. Used as the home-screen icon on iOS and as the adaptive-icon foreground on Android. The background tint is taken from `capacitor.config.ts -> plugins.SplashScreen.backgroundColor`. |
| `splash.png` | 2732×2732 canvas. Centre of the image is shown; the rest is cropped to match the device's aspect ratio. |
| `splash-dark.png` | Dark variant for devices in dark mode. |

The files in this directory are **placeholder** artwork — plain
stone/amber branding. Replace them with finished artwork at the same
filenames and dimensions before shipping, then re-run
`pnpm --filter @cookyourbooks/mobile assets`.

## Generating

```bash
pnpm --filter @cookyourbooks/mobile assets
# shorthand for: cap-assets generate --assetPath=assets
```

The command inspects both `ios/` and `android/` projects (created via
`cap add ios` / `cap add android`) and writes platform-specific sizes
into each. It has no effect if a native project is missing.
