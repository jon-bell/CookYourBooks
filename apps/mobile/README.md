# @cookyourbooks/mobile

Capacitor wrapper around the web app in `apps/web`. Produces iOS and
Android native projects from the same React codebase.

## Layout

- `capacitor.config.ts` — app id (`app.cookyourbooks`), name
  (`CookYourBooks`), and `webDir` (`../web/dist`).
- `assets/` — master icon (`icon-only.png`) and splash sources.
  `pnpm assets` fans these out into the per-platform sizes.
- `ios/` — native Xcode project (committed). Build artifacts (`Pods/`,
  `build/`, `DerivedData/`, generated `capacitor.config.json`) are
  ignored by the platform-level `.gitignore` that `cap add` wrote.
- `ios/fastlane/` — release automation. Lanes documented below.
- `android/` — native Gradle project (committed). Build artifacts
  (`build/`, `.gradle/`, the synced `app/src/main/assets/public`,
  generated config) are ignored by the platform-level `.gitignore` that
  `cap add` wrote. See the **Android** section below.
- `android/fastlane/` — Google Play release automation.

Plugins in use: `@capacitor/camera` (OCR capture), `@capacitor/haptics`
(cook-mode feedback), `@capacitor/share` (export sheet), `@capacitor/browser`
(native OAuth via the system browser), plus `@capacitor/app` + `send-intent`
(share-target / deep links).

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

---

# Android

The Android app is the same `apps/web` bundle wrapped by Capacitor, under
`apps/mobile/android/` (committed, like `ios/`). Unlike iOS it builds on
**Linux** — no Mac required — so CI builds and ships it from the Linux runner.

## One-time machine setup (Android)

Capacitor 6 projects build with **JDK 17** (AGP 8.2.1 / Gradle 8.2.1,
compileSdk/targetSdk 34, minSdk 22). You need a JDK and the Android SDK
command-line tools; **Android Studio is optional** (only handy for an emulator
or the GUI). This works on a headless Linux box for *building*:

```bash
# JDK 17 (Debian/Ubuntu shown; on macOS: `brew install temurin@17`)
sudo apt-get update && sudo apt-get install -y openjdk-17-jdk unzip

# Android SDK under $HOME (NOT a small/RAM-backed tmpfs — the SDK is GBs).
export ANDROID_HOME="$HOME/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"     # some tools still read the old name
mkdir -p "$ANDROID_HOME/cmdline-tools"
cd "$ANDROID_HOME/cmdline-tools"
# Grab the current "command line tools only" zip URL from
# https://developer.android.com/studio#command-line-tools-only
curl -fsSL -o clt.zip https://dl.google.com/android/repository/commandlinetools-linux-<BUILD>_latest.zip
unzip -q clt.zip && rm clt.zip && mv cmdline-tools latest

export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

Put `ANDROID_HOME`/`ANDROID_SDK_ROOT` and the two `PATH` entries in your shell
profile. For build + upload that's everything; an **emulator** additionally
needs `sdkmanager "emulator" "system-images;android-34;google_apis;x86_64"` and
a created AVD (see below).

## Day-to-day (Android)

```bash
# Build web + cap sync (run after every change in apps/web/src)
pnpm --filter @cookyourbooks/mobile sync

# Open the project in Android Studio (optional)
pnpm --filter @cookyourbooks/mobile open:android

# Regenerate icons / splashes after editing assets/icon-only.png etc.
pnpm --filter @cookyourbooks/mobile assets

# Fast iteration: build the debug APK + install + launch on a device/emulator.
scripts/run-android-emulator.sh
# AVD="Pixel_7_API_34" scripts/run-android-emulator.sh
```

### Emulator / "simulator" on this kind of box — read this

The Android emulator needs hardware virtualization (**`/dev/kvm`** on Linux) to
be usable. Without it the emulator falls back to software CPU emulation
(~3–5 FPS) — far too slow for a WebView app (it loads a React SPA + cr-sqlite
WASM): boot alone can take 10–20+ min and the WebView may ANR. **Headless /
container hosts — including the CI runner and most cloud dev workspaces — have
no `/dev/kvm`, so they are build-only.** Check with `ls -l /dev/kvm`.

So the realistic options are:

- **Build here, run elsewhere (recommended).** This box (and CI) build the
  APK/AAB and `fastlane` uploads it — none of that needs an emulator. Run the
  actual emulator on a workstation that **has** `/dev/kvm` (a Linux machine
  whose user is in the `kvm` group) or on macOS/Windows (native hypervisor).
- **Physical device over `adb`.** Enable USB debugging, plug in, then
  `scripts/run-android-emulator.sh` installs + launches onto it.
- **Remote emulator.** Run the emulator on a KVM-capable host and
  `adb connect <host>:5555` from here.

`scripts/run-android-emulator.sh` detects the no-KVM / no-device case, still
builds the APK, and prints the above. To create a local AVD on a capable
machine:

```bash
sdkmanager "emulator" "system-images;android-34;google_apis;x86_64"
avdmanager create avd -n Pixel_7_API_34 -k "system-images;android-34;google_apis;x86_64" -d pixel_7
```

### Debugging the WebView (Android)

With a device/emulator on `adb`, open desktop **Chrome → `chrome://inspect` →
Remote Target → Inspect**. You get the full DevTools (DOM, console, network,
sources) against the running WebView — the Android analog of the iOS
Safari → Develop → Simulator flow, and the fastest way to diagnose a white
screen or a sync hang.

## Native specifics wired into the Android project

These were added by hand on top of `cap add android` (so re-running `cap sync`
keeps them). If you regenerate the project from scratch, re-apply them:

- **Permissions** (`app/src/main/AndroidManifest.xml`): `CAMERA` +
  `READ_MEDIA_IMAGES` + `READ_EXTERNAL_STORAGE` (maxSdkVersion 32) for the OCR
  camera/gallery flow, plus `<uses-feature android:name="android.hardware.camera"
  android:required="false">` so camera-less devices can still install.
  `VIBRATE` (haptics) merges in from the plugin. The Camera plugin does **not**
  declare its permissions — the app must.
- **`cookyourbooks://` deep link**: a `VIEW` intent-filter on `MainActivity`.
  Used by both the share-import flow and the native OAuth return (below).
- **Share target**: an `ACTION_SEND` (`text/plain`) intent-filter on
  `MainActivity`. The `send-intent` plugin reads the shared link but does **not**
  contribute the filter on sync — it's declared by hand.
- **Google sign-in via the system browser**: Google blocks OAuth inside embedded
  WebViews (`disallowed_useragent`), so on native we open the provider's
  authorize URL in a Chrome Custom Tab (`@capacitor/browser`) and Supabase
  redirects back to `cookyourbooks://auth/callback`, which `apps/web/src/auth/
  authDeepLink.ts` exchanges for a session (PKCE — see `apps/web/src/supabase.ts`).
  **This needs `cookyourbooks://auth/callback` added to Supabase → Auth → URL
  Configuration → Redirect URLs** (one-time, hosted). Email/password and the
  iOS-native Apple flow are unaffected.

## App icons / splash

`pnpm assets` (`@capacitor/assets`) fans `assets/icon-only.png` and the splash
masters into Android resources. With only a single square master it produces a
**legacy** launcher icon (no adaptive foreground/background layers) — fine for
v1; add `assets/icon-foreground.png` + `assets/icon-background.png` later for an
adaptive icon. The launch theme uses `@drawable/splash`; we commit only the base
`res/drawable/splash.png` (+ `drawable-night`) and **gitignore the per-density
splash variants** (`drawable-land-*`, `drawable-port-*`, ~22 MB) — CI regenerates
the full set into the shipped artifact via the assets step.

---

## Publishing to Google Play

Release automation lives in `android/fastlane/` and mirrors the iOS lanes.
Unlike iOS (`match` + a certs repo), Android signing material flows through
**base64 GitHub secrets decoded at job start** (the same pattern as the iOS ASC
`.p8`), because `match` is iOS-only.

### Prerequisites (one-time, per Google Play account)

1. **Google Play Developer account** — one-time `$25` registration.
2. **Create the app** for package `app.cookyourbooks` in the Play Console
   (set default language + enough store details to save a draft).
3. **Opt into Play App Signing** (default for new apps): Google holds the *app
   signing key*; you sign uploads with an *upload key* (recoverable if lost).
   Generate the upload keystore:
   ```bash
   keytool -genkeypair -v -keystore upload-keystore.jks -alias upload \
     -keyalg RSA -keysize 2048 -validity 9125
   ```
   Register/derive its certificate in the Console per the Play App Signing flow.
4. **Manually upload the first AAB** to a track (internal is fine) in the
   Console. `supply` (fastlane) **cannot create the very first version** of a
   brand-new app over the API — it can only add builds after one exists.
5. **Service account for the API**: in Google Cloud create a service account,
   then in Play Console → *Users & permissions* invite its email and grant
   *Release to testing tracks* (+ *production* for the release lane). Download
   its JSON key. API access can take up to ~48 h to propagate on a freshly
   linked account. Validate locally:
   ```bash
   cd apps/mobile/android
   bundle exec fastlane run validate_play_store_json_key json_key:/path/to/play.json
   ```
6. **Supabase redirect URL**: add `cookyourbooks://auth/callback` to Auth → URL
   Configuration → Redirect URLs (for native Google sign-in).

### Local fastlane env

```bash
cp android/fastlane/.env.example android/fastlane/.env
# Fill in CYB_PLAY_JSON_KEY + the CYB_UPLOAD_* upload-keystore values.
```

### Ship to the internal track (TestFlight analog)

```bash
cd apps/mobile/android
bundle exec fastlane beta
```

`beta` (1) sets `versionCode` to `git rev-list --count HEAD` (monotonic, no
network — same as the iOS build number), (2) builds a signed Release **AAB**
(`gradle bundle`, signed with the upload key from `CYB_UPLOAD_*`), (3) uploads
the R8/ProGuard mapping to Sentry **if present** (it isn't while
`minifyEnabled false` — JS source maps cover symbolication and upload during the
web build), and (4) `supply`s the AAB to the **internal** track. Internal builds
need no review and reach testers in minutes.

### Promote to production

```bash
cd apps/mobile/android
bundle exec fastlane release         # PLAY_ROLLOUT=1 for a full (non-staged) rollout
```

`release` promotes the latest internal build to **production** with a staged
rollout (default 20%) you ramp manually in the Console — the Play analog of the
iOS `deliver(automatic_release: false)` hold. It does **not** rebuild.

### Common pitfalls (Android)

- **First release fails until setup is done.** Until the manual first AAB +
  propagated service account exist, `fastlane beta` will fail. CI's android job
  is **dormant** until the Play secrets are set (it builds `assembleDebug`
  instead of shipping), so `main` stays green meanwhile.
- **JDK must be 17.** AGP 8.2.1 won't run on JDK 11; JDK 21 causes warnings.
  Pin Temurin 17 everywhere.
- **Don't flip `minifyEnabled` to true casually.** R8 white-screens the
  Capacitor WebView unless you add `-keep` rules for Capacitor + every plugin.
  We keep it off (the native surface is tiny); JS source maps do the
  symbolication.
- **`versionCode` must only increase.** It's the commit count, so force-pushes /
  history rewrites on `main`, or releasing from a short side branch, can produce
  a `versionCode` Play rejects as already-used. CI checks out with full history
  (`fetch-depth: 0`).
- **Bundle/package ID drift.** `app.cookyourbooks` must match in
  `capacitor.config.ts`, `app/build.gradle` (`applicationId`/`namespace`), the
  Play Console listing, and the service account's granted app.
- **Cleartext.** `capacitor.config.ts` sets `android.allowMixedContent: true`
  for LAN dev; release builds default to `usesCleartextTraffic=false` (targetSdk
  34) and talk to HTTPS Supabase, so production is fine. For device testing
  against local Supabase over HTTP, point the env at your machine's LAN IP and
  add a debug `network_security_config.xml`.

### CI (Android)

`mobile.yml`'s `android` job mirrors the iOS cadence, on the Linux runner:

- **PR touching mobile code** / `workflow_dispatch=android` → unsigned
  `assembleDebug` sanity build (no secrets).
- **push to `main`** → `fastlane beta` (signed AAB → Play internal track), or a
  build-only `assembleDebug` while the Play secrets aren't configured yet.
- **`workflow_dispatch=android-release`** → `fastlane release` (promote to
  production).

Secrets needed (see `.github/RUNNERS.md`): `CYB_PLAY_JSON_KEY_BASE64`,
`CYB_UPLOAD_KEYSTORE_BASE64`, `CYB_UPLOAD_STORE_PASSWORD`, `CYB_UPLOAD_KEY_ALIAS`,
`CYB_UPLOAD_KEY_PASSWORD` (plus the shared `SENTRY_AUTH_TOKEN`,
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). Base64-encode the two files:

```bash
base64 -w0 upload-keystore.jks | gh secret set CYB_UPLOAD_KEYSTORE_BASE64
base64 -w0 play-service-account.json | gh secret set CYB_PLAY_JSON_KEY_BASE64
```
