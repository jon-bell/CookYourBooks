# Mobile assets

Source artwork for app icons and splash screens. `@capacitor/assets`
reads these and emits per-platform sizes into the native Xcode / Gradle
projects.

| File | Purpose |
| ---- | ------- |
| `icon-only.png` | 1024×1024 square icon. Used as the home-screen icon on iOS and as the adaptive-icon foreground on Android. Must be opaque (no alpha) — iOS rejects transparent icons. |
| `splash.png` | 2732×2732 canvas. Centre is shown; the rest is cropped to match each device's aspect ratio. |
| `splash-dark.png` | Dark-mode variant. |

The master source artwork lives at `../../cyb-master.png` (2152×2152,
opaque black background). The current `icon-only.png` / `splash.png` /
`splash-dark.png` were derived from it with `sips`:

```bash
# From repo root
sips -z 1024 1024 cyb-master.png --out apps/mobile/assets/icon-only.png
sips -z 2732 2732 -p 2732 2732 --padColor 000000 \
  cyb-master.png --out apps/mobile/assets/splash.png
cp apps/mobile/assets/splash.png apps/mobile/assets/splash-dark.png
```

After editing any of these, regenerate the per-platform sizes:

```bash
pnpm --filter @cookyourbooks/mobile assets
```

The command inspects `ios/` (and `android/` when present) and writes
platform-specific sizes into each. It has no effect if a native project
is missing.
