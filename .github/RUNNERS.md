# Self-hosted runners

Linux runners come from Actions Runner Controller (ARC) scale sets;
their `runs-on:` is a bare scale-set name. The macOS iOS runner is a
single classic self-hosted runner and uses the traditional label list.

## Runners

| Runner label | Workflows | Status | Notes |
|---|---|---|---|
| `ripley-cloud-linux-x64` | `ci.yml`, `mobile.yml` (Capacitor sync + Android) | Active | Linux x86_64 ARC scale set. Docker daemon available, first Supabase image pull warms the runner cache. |
| `[self-hosted, macOS, X64, cyb-mac]` | `mobile.yml` (iOS) | Active | Single classic runner on @jon-bell's x86 MacBook. Builds + signs the iOS app and ships to TestFlight (push to main) or App Store (manual dispatch). |

## What each scale set needs installed

### Linux (`ripley-cloud-linux-x64`)

- Docker daemon reachable to the runner user (`docker ps` without `sudo`).
- Outbound network to `public.ecr.aws` (Supabase image pulls) and
  `registry.npmjs.org` / `github.com` (pnpm + Playwright downloads).
- No pre-installed Node or pnpm — `actions/setup-node` +
  `pnpm/action-setup` install them per job.
- Port range 54420–54429 bound to `127.0.0.1` only; no external exposure
  needed. Multiple runners on the same host would collide here; keep one
  runner per host or shift the port range per runner.
- For the Android job: JDK 17 (`actions/setup-java`) + the Android SDK
  (`android-actions/setup-android`); `./gradlew` pulls the rest on first
  run. The release path additionally uses Ruby + bundler
  (`ruby/setup-ruby`, gated on the Play secrets) to run `fastlane`. No
  emulator / KVM is needed — the job only builds the AAB and uploads it
  via the Play API, so it runs entirely on this Linux runner.

### macOS iOS runner (`cyb-mac` label)

The runner runs as user `jon` on a x86 MacBook. Setup:

- Xcode 15+ with the iOS platform downloaded
  (`xcodebuild -downloadPlatform iOS`, ~10GB).
- Xcode license accepted (`sudo xcodebuild -license accept`) and first
  launch run (`sudo xcodebuild -runFirstLaunch`).
- Homebrew (`brew install cocoapods fastlane`) — avoid the system Ruby
  2.6 gem path, it can't build modern CocoaPods' ffi dependency.
- nvm + Node 20 (the workflow sources `/usr/local/opt/nvm/nvm.sh` and
  runs `nvm use 20`).
- SSH key for `jon-bell` GitHub user added to the agent so the runner
  can clone the certs repo and (via match) push back to it. The repo
  checkout uses the github-actions token but match uses git+ssh.
- **Signing identity in the login keychain.** After running
  `fastlane bootstrap_signing` once, the `Apple Distribution: …`
  identity lives in `~/Library/Keychains/login.keychain-db`. The
  keychain must be unlocked AND the partition list set
  (`security set-key-partition-list -S apple-tool:,apple:,codesign: -s
  ~/Library/Keychains/login.keychain-db`) so codesign can use the key
  non-interactively. Either keep an interactive session logged in with
  the keychain unlocked, or set up a launchd job that
  `security unlock-keychain`s at boot.
- Runner registered to `jon-bell/CookYourBooks` with labels
  `self-hosted,macOS,X64,cyb-mac`, installed as a launchd service so it
  comes back after reboot.

#### Registering the runner (one-time)

```bash
# In Settings → Actions → Runners → New self-hosted runner → macOS
# GitHub gives you a token-bearing command. Run it from a fresh dir:
mkdir -p ~/actions-runner && cd ~/actions-runner
# Download the matching version (current: 2.319.x for x86 macOS):
curl -O -L https://github.com/actions/runner/releases/download/v2.328.0/actions-runner-osx-x64-2.328.0.tar.gz
tar xzf ./actions-runner-osx-x64-2.328.0.tar.gz

./config.sh \
  --url https://github.com/jon-bell/CookYourBooks \
  --token <REG_TOKEN_FROM_GITHUB_UI> \
  --name cyb-mac \
  --labels self-hosted,macOS,X64,cyb-mac \
  --work _work \
  --unattended

# Install as a launchd service so it survives reboot
./svc.sh install
./svc.sh start
./svc.sh status
```

The PR-time job (or `workflow_dispatch=ios`) runs an unsigned Debug
simulator build (no secrets needed). Push to `main` triggers
`fastlane beta` (signed Release IPA → TestFlight). Manual
`workflow_dispatch=ios-release` triggers `fastlane release`
(beta + submit for App Store review).

#### Resilience: keychain auto-unlock LaunchAgent (one-time)

The runner's signing identity lives in the user's login keychain, which
re-locks on idle and refuses to release the private key to non-interactive
processes. Without intervention, the first CI job after a reboot / long
idle hangs at codesign. Fix: a LaunchAgent that runs `security
unlock-keychain` at login and every 30 minutes thereafter, reading the
login password from a keychain entry that only `/usr/bin/security` can
access.

```bash
scripts/runner/install-launch-agents.sh
# Prompts ONCE for your Mac login password. Stores it under service
# 'cyb-mac-runner-keychain-unlock' in your user keychain, granted only to
# /usr/bin/security. Reload-safe — re-running just reloads the agent.
```

After install, every CI job's pre-flight step verifies the Apple
Distribution identity is visible via `security find-identity`; if not,
it emits a workflow warning pointing at this script.

#### Pre-job cleanup

`mobile.yml` runs a `Pre-job cleanup` step that:
- Deletes Xcode DerivedData directories untouched for >2 days
- Deletes stale fastlane build/ output
- Prints `df -h` so disk pressure shows up in the job log
- Verifies the signing identity is reachable

This keeps a single-tenant Mac from filling up between manual cleanups.

#### Recovery: if this Mac dies / gets stolen

Everything that makes this runner work is reproducible. To stand up a
replacement Mac:

1. Install Xcode 15+ → `xcodebuild -downloadPlatform iOS` →
   `sudo xcodebuild -license accept` → `sudo xcodebuild -runFirstLaunch`.
2. `brew install cocoapods fastlane gh` and the Node toolchain (nvm +
   Node 20 + `corepack enable`).
3. `gh auth login` as `jon-bell` (or whoever owns the repo).
4. Clone the repo, `cd CookYourBooks`, `pnpm install`.
5. `cp apps/mobile/ios/fastlane/.env.example apps/mobile/ios/fastlane/.env`
   and refill the `CYB_ASC_*` + `MATCH_PASSWORD` values (the `.p8` itself
   lives in the App Store Connect API keys page → if you lost it, mint a
   new ASC API key and update the GitHub secret too).
6. `cd apps/mobile/ios && fastlane certs` — pulls the existing signing
   cert + provisioning profile from `cookyourbooks-certs` into the new
   Mac's login keychain. Run `security set-key-partition-list -S
   apple-tool:,apple:,codesign: -s ~/Library/Keychains/login.keychain-db`
   so codesign can use it non-interactively.
7. `scripts/runner/install-launch-agents.sh` — installs the
   keychain-unlock LaunchAgent.
8. Register the actions runner per
   [Registering the runner](#registering-the-runner-one-time), reusing
   the `cyb-mac` label so workflows pick it up automatically.

If the **signing key itself** is unrecoverable (lost the keychain AND
the certs repo), `fastlane bootstrap_signing` will regenerate it —
revoke the old cert in the developer portal first to free up the
2-cert-per-account cap.

#### When this single Mac isn't enough

For a real fallback (e.g. this Mac is offline during a release window),
add a GitHub-hosted `macos-latest` runner option to `mobile.yml` and
move the secrets into a workflow-level env. Costs $0.08/min vs $0 on the
self-hosted runner, but it gets you over the hump. Not wired today.

## Secrets

None required by `ci.yml` — the Supabase stack is started locally inside
the job. Mobile **release** builds (not the PR smoke build) need:

| Secret | Where used | Notes |
|---|---|---|
| `MATCH_PASSWORD` | `fastlane match` | Symmetric password used to encrypt the certs repo. Same value on every machine. |
| `CYB_ASC_KEY_ID` | `fastlane pilot`, `fastlane deliver` | 10-char key ID from the ASC API key. |
| `CYB_ASC_ISSUER_ID` | same | UUID issuer ID for the ASC team. |
| `CYB_ASC_KEY_P8_BASE64` | same | The `.p8` private key, base64-encoded. The job decodes it into a file at start and points `CYB_ASC_KEY_PATH` at it. The `CYB_` prefix avoids fastlane's auto-detection of `APP_STORE_CONNECT_API_KEY_*` — see `apps/mobile/ios/fastlane/.env.example`. |
| `VITE_SUPABASE_URL` | web build (baked into bundle) | Hosted Supabase project URL, e.g. `https://xdyhhycfolcpqdawfkcj.supabase.co`. The mobile app reaches the cloud, not the dev machine, so the URL must be the deployed project. |
| `VITE_SUPABASE_ANON_KEY` | web build (baked into bundle) | The hosted project's publishable / anon key. Safe to ship in a client — public, RLS-gated. |
| `CYB_PLAY_JSON_KEY_BASE64` | `fastlane supply` (Android) | base64 of the Google Play service-account JSON. Decoded to a file at job start; `CYB_PLAY_JSON_KEY` points at it. Also the **dormant gate**: when unset, push-to-main builds `assembleDebug` instead of shipping, so `main` stays green. |
| `CYB_UPLOAD_KEYSTORE_BASE64` | Gradle release signing (Android) | base64 of the upload keystore (`.jks`). Decoded to a file; `CYB_UPLOAD_STORE_FILE` points at it. With Play App Signing this is the recoverable *upload* key, not the app key. |
| `CYB_UPLOAD_STORE_PASSWORD` | Gradle release signing (Android) | Upload keystore password. |
| `CYB_UPLOAD_KEY_ALIAS` | Gradle release signing (Android) | Upload key alias (e.g. `upload`). |
| `CYB_UPLOAD_KEY_PASSWORD` | Gradle release signing (Android) | Upload key password. |

To populate `CYB_ASC_KEY_P8_BASE64`:
```bash
base64 -i ~/.appstoreconnect/AuthKey_XXXXXXXXXX.p8 | pbcopy
# Paste into Settings → Secrets and variables → Actions → New repository secret
```

Android release builds need the five `CYB_PLAY_JSON_KEY_BASE64` /
`CYB_UPLOAD_*` secrets in the table above (the Play service-account JSON
plus the upload keystore and its passwords, base64-encoded). Until they're
set, the `android` job builds `assembleDebug` only, so `main` stays green.
The full one-time Play setup (developer account, create the app, Play App
Signing, the manual first AAB upload, and the service account) is in
`apps/mobile/README.md` → **Android → Publishing to Google Play**.

## Debugging a failed CI run

- **`playwright-report-*`** artifact has the HTML report with traces,
  screenshots, and videos.
- **`playwright-test-results-*`** artifact has the raw per-test
  directories (trace.zip, video.webm) for replaying in the Playwright UI.
- Supabase container logs are printed inline in the job output — expand
  the "Supabase logs on failure" step.
