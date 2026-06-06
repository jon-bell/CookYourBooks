# @cookyourbooks/mobile

Capacitor wrapper around the web app in `apps/web`. Produces an iOS
native project (and eventually Android) from the same React codebase.

## Layout

- `capacitor.config.ts` — app id (`app.cookyourbooks`), name
  (`CookYourBooks`), and `webDir` (`../web/dist`).
- `assets/` — master icon (`icon-only.png`) and splash sources.
  `pnpm assets` fans these out into the per-platform sizes.
- `ios/` — native Xcode project (committed). Build artifacts (`Pods/`,
  `build/`, `DerivedData/`, generated `capacitor.config.json`) are
  ignored by the platform-level `.gitignore` that `cap add` wrote.
- `ios/fastlane/` — release automation. Lanes documented below.

Plugins in use: `@capacitor/camera` (OCR capture), `@capacitor/haptics`
(cook-mode feedback), `@capacitor/share` (export sheet).

## One-time machine setup

CookYourBooks uses Node 20+ and pnpm via corepack. CocoaPods + fastlane
come from Homebrew so we don't fight macOS's system Ruby 2.6.

```bash
# Node 20 (via nvm — adjust if you use volta/asdf/etc.)
nvm install 20 && nvm use 20
corepack enable && corepack prepare pnpm@10.33.0 --activate

# Xcode 15+ (App Store from Apple's site). After install:
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch

# iOS platform components — multi-GB, only needed once per Xcode upgrade.
xcodebuild -downloadPlatform iOS

# CocoaPods + fastlane + a modern Ruby (system Ruby 2.6 is too old for
# fastlane plugins; brew Ruby ships bundler).
brew install cocoapods fastlane ruby

# Fastlane plugins (fastlane-plugin-sentry for dSYM upload) are
# vendored via bundler — install them once per machine:
(cd apps/mobile/ios && PATH="/usr/local/opt/ruby/bin:$PATH" bundle install)
```

If RVM is in your shell init, it pollutes `GEM_PATH` and breaks the
brew-installed `pod` / `fastlane` binaries. Run them in a clean
sub-shell or unset RVM vars per session:

```bash
unset GEM_PATH GEM_HOME RUBY_VERSION MY_RUBY_HOME IRBRC rvm_path
```

Then call `bundle exec fastlane <lane>` instead of `fastlane <lane>` so
the vendored plugin gems are on the load path.

## Day-to-day

```bash
# Build web + cap sync (run after every change in apps/web/src)
pnpm --filter @cookyourbooks/mobile sync

# Open the Xcode workspace (NOT the .xcodeproj — Pods needs the workspace)
pnpm --filter @cookyourbooks/mobile open:ios

# Regenerate icons / splashes after editing assets/icon-only.png etc.
pnpm --filter @cookyourbooks/mobile assets

# Fast iteration loop: build + install + launch on the iOS Simulator.
# Defaults to iPhone 17 Pro; override with SIM env var.
scripts/run-ios-sim.sh
# SIM="iPhone 17e" scripts/run-ios-sim.sh
```

### Debugging the WebView

While the simulator is running, open Safari on macOS → Develop →
Simulator → CookYourBooks. You get the full Web Inspector (DOM,
console, network, sources) against the running app — same flow as
debugging a regular web page, plus a `device` (the WKWebView) target.
This is the fastest way to diagnose a white screen or a sync hang.

## Backend configuration

The mobile app reads the same `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` that were baked into the web build at
`apps/web/dist`. For device testing against local Supabase you need to:

1. Replace `127.0.0.1` with your machine's LAN IP in
   `apps/web/.env.local` (the iOS simulator can reach `localhost` but a
   real device on Wi-Fi cannot).
2. Rebuild: `pnpm --filter @cookyourbooks/mobile sync`.

For App Store builds, point the env at the deployed Supabase project
and remove the `allowMixedContent` / ATS-permissive settings in
`capacitor.config.ts` (cleartext should not ship to production).

## Native integrations in the web code

The web package already calls out to Capacitor plugins behind runtime
feature detection — both paths live in `apps/web/src/`:

- `import/camera.ts` — `Camera.getPhoto()` on native, `<input
  type="file" capture>` on web.
- `pages/CookModePage.tsx` — `Haptics.impact()` on native, no-op on web.
- `import/shareIntent.ts` — receives a shared video link from the OS
  share sheet and routes to `/import/link?url=…`. It talks to the
  `send-intent` and `@capacitor/app` plugins through the global
  `Capacitor.Plugins` registry, so the web bundle never imports them; on
  the web it's an inert no-op.

No platform-specific fork of the UI is needed.

### Share target: "Share to CookYourBooks"

Lets a user share a YouTube/TikTok/Instagram link from another app into
CookYourBooks, which deep-links into the import-from-link flow and
auto-extracts. The JS deps (`@capacitor/app`, `send-intent`) are already
in `package.json`, so `pnpm --filter @cookyourbooks/mobile sync` wires the
pods/manifest. The pieces that need native project setup (do once, on a
macOS machine, then commit the Xcode changes):

1. **Android** — `send-intent` contributes the `ACTION_SEND`
   (`text/plain`) intent filter to `AndroidManifest.xml` on `cap sync`.
   Nothing else required.
2. **iOS Share Extension** — add a Share Extension target in Xcode
   following the `send-intent` README. Use bundle id
   `app.cookyourbooks.ShareExtension` (already registered in `fastlane/
   Matchfile`).
3. **App Group** — add `group.app.cookyourbooks` to the App **and** the
   Share Extension entitlements so the extension can hand the shared URL
   to the host app.
4. **URL scheme** — `cookyourbooks://` is already declared in the app's
   `Info.plist` (`CFBundleURLTypes`); the extension wakes the host app via
   this scheme and `@capacitor/app` delivers it to `shareIntent.ts`.
5. **Provisioning** — run `fastlane match appstore` after adding the new
   bundle id so the extension gets its profile (the Matchfile already
   lists it).

The web handler + the `/import/link?url=…` deep-link contract are covered
by the Playwright suite; the actual share-sheet hop is a manual
device/simulator smoke test.

---

## Publishing to TestFlight / App Store

### Prerequisites (one-time, per Apple Developer account)

1. **Apple Developer Program membership** — `$99/yr`. Team ID for this
   app is `YNDYJ3A9CQ`.
2. **App Store Connect record** for `app.cookyourbooks`. Create
   at <https://appstoreconnect.apple.com/apps> → `+` → New App → iOS.
   You'll need a unique SKU (anything, e.g. `cookyourbooks-001`) and a
   primary language.
3. **App Store Connect API key** — generate at <https://appstoreconnect.apple.com/access/integrations/api>
   with the "App Manager" role. Download the `.p8` file once
   (Apple does not let you re-download it). Stash it somewhere like
   `~/.appstoreconnect/AuthKey_XXXXXX.p8`. Note the Key ID + Issuer ID.
4. **Signing certs repo** — already created at
   `git@github.com:jon-bell/cookyourbooks-certs.git`. Anyone with push
   access can sign as you, so keep its membership tight.
5. **Local fastlane env**:
   ```bash
   cp ios/fastlane/.env.example ios/fastlane/.env
   # Fill in the four values: KEY_ID, ISSUER_ID, KEY_PATH, MATCH_PASSWORD.
   ```

### Bootstrap signing (one time)

The first time anyone runs the release pipeline, generate fresh
distribution + development certs and push them to the certs repo
encrypted with `MATCH_PASSWORD`:

```bash
cd apps/mobile/ios
fastlane bootstrap_signing
```

After this runs once successfully, every other dev machine (and CI) can
pull the same signing material with `fastlane certs` — no need to
juggle `.p12` files by hand.

### Ship a TestFlight build

```bash
cd apps/mobile/ios
fastlane beta
```

What `beta` does:

1. `match(type: "appstore", readonly: true)` — pulls the distribution
   cert + provisioning profile from the certs repo.
2. `bump_build` — sets `CURRENT_PROJECT_VERSION` to one above whatever
   build number is currently on TestFlight. Avoids the "build number
   already used" upload rejection.
3. `gym` — builds a signed Release archive (`.ipa`) into `build/`.
4. `upload_dsyms_to_sentry` — pushes the build's dSYM debug symbols
   to the self-hosted Sentry (`cookyourbooks-mobile` project) so
   native iOS crashes get symbolicated. No-op when `SENTRY_AUTH_TOKEN`
   isn't set, so unconfigured machines just skip it.
5. `pilot` — uploads the IPA to TestFlight via the ASC API key.

The build is then visible at <https://appstoreconnect.apple.com/apps> →
CookYourBooks → TestFlight. Add it to a test group (internal testing
needs no review and ships in ~10 minutes).

If the dSYM upload failed (or was skipped because the env var was
missing) you can re-run it without rebuilding:

```bash
cd apps/mobile/ios
SENTRY_AUTH_TOKEN=sntrys_... fastlane upload_dsyms
# Or target an older archive explicitly:
SENTRY_AUTH_TOKEN=... fastlane upload_dsyms \
  path:~/Library/Developer/Xcode/Archives/2026-05-26/CookYourBooks.xcarchive/dSYMs
```

### Submit for App Store review

```bash
cd apps/mobile/ios
fastlane release
```

This runs `beta` then `deliver --submit-for-review`. Screenshots and
store metadata stay manual for now — manage them in App Store Connect's
web UI until we automate them.

### Common pitfalls

- **Export compliance:** Already set — `ITSAppUsesNonExemptEncryption=false`
  is in `ios/App/App/Info.plist` so TestFlight uploads don't prompt.
- **App icon transparency:** iOS rejects icons with alpha. Our
  `cyb-master.png` master has a solid black background so this is fine,
  but if you ever swap it, flatten the PNG first.
- **ATS / cleartext:** Production should not ship with
  `allowMixedContent`. Strip it from `capacitor.config.ts` before
  running `fastlane release`.
- **Bundle ID drift:** Bundle ID must stay `app.cookyourbooks` in
  `capacitor.config.ts`, the Xcode project, the Matchfile, and the App
  Store Connect record. Changing one without the others breaks match.
- **Xcode 26+ + RVM:** The `pod` / `fastlane` binaries from Homebrew
  fail with "Could not find 'mutex_m'" when RVM env vars are set. Run
  in a sub-shell with RVM vars unset (see "One-time machine setup").
- **Keychain locked during match:** If you see "Could not find the newly
  generated certificate installed", your login keychain re-locked and
  match's `security import` of the .p12 silently failed. Fix:
  `security unlock-keychain ~/Library/Keychains/login.keychain-db` then
  `security set-keychain-settings -l ~/Library/Keychains/login.keychain-db`
  to disable the idle auto-lock for the session, then retry.
- **"Reached the maximum number of available Distribution certificates":**
  Apple caps each account at 2 active "Apple Distribution" certs. Every
  failed match attempt that got past API auth but failed at local import
  leaves an orphan cert. Use `fastlane list_certs` to see all certs on
  the account, then `fastlane revoke_certs ids:abc,def` to clean up
  orphans. Only certs whose `.p12` is in the certs repo are useful —
  everything else is safe to revoke.
- **Match defaults to `master` branch, not `main`:** Our Matchfile sets
  `git_branch("main")` explicitly. If you ever swap to a different certs
  repo, set this on day one or match will silently push to `master` on a
  repo that defaults to `main`.

### CI

`mobile.yml` has an iOS job that runs an unsigned simulator build on
push/PR (via manual `workflow_dispatch`). Real release archives should
run from a macOS runner with:

- `MATCH_PASSWORD` available as a secret.
- `CYB_ASC_KEY_ID`, `CYB_ASC_ISSUER_ID`, and the `.p8` content
  (base64-encoded into a secret, decoded into a file at job start,
  pointed at by `CYB_ASC_KEY_PATH`).
- SSH access to the certs repo (deploy key or PAT in a secret).

See `.github/RUNNERS.md` for runner provisioning notes.
