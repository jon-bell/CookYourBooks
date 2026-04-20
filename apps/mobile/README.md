# @cookyourbooks/mobile

Capacitor wrapper around the web app in `apps/web`. Produces iOS and
Android projects from the same React codebase.

## Layout

- `capacitor.config.ts` — app id, name, and `webDir` (`../web/dist`).
- Native projects are generated under `ios/` and `android/` by the
  Capacitor CLI — **run `pnpm add:ios` / `pnpm add:android` once** to
  create them (they're not checked in by default to keep the monorepo
  small).
- Plugins used: `@capacitor/camera` (OCR capture), `@capacitor/haptics`
  (cook mode feedback).

## Running

```bash
# From the repo root
pnpm --filter @cookyourbooks/mobile add:ios         # one-time scaffold
pnpm --filter @cookyourbooks/mobile add:android     # one-time scaffold

# Every time you make web changes:
pnpm --filter @cookyourbooks/mobile sync            # build web + cap sync

# Open in Xcode / Android Studio:
pnpm --filter @cookyourbooks/mobile open:ios
pnpm --filter @cookyourbooks/mobile open:android
```

## Backend configuration

The mobile app reads the same `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
that were baked into the web build at `apps/web/dist`. For device testing
against local Supabase you need to:

1. Replace `127.0.0.1` with your machine's LAN IP in
   `apps/web/.env.local` (Android and iOS simulators can't reach
   `127.0.0.1` on the host — iOS can use `localhost`, Android
   cannot).
2. Rebuild: `pnpm --filter @cookyourbooks/mobile sync`.

For App Store / Play Store builds, point the env at a deployed Supabase
instance and flip `allowMixedContent` / ATS settings off in
`capacitor.config.ts` accordingly.

## Native integrations in the web code

The web package already calls out to Capacitor plugins behind runtime
feature detection — both paths live in `apps/web/src/`:

- `import/camera.ts` — `Camera.getPhoto()` on native, `<input
  type="file" capture>` on web.
- `pages/CookModePage.tsx` — `Haptics.impact()` on native, no-op on web.

No platform-specific fork of the UI is needed.
