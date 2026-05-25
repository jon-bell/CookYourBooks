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
- For the Android job: JDK 17 (via `actions/setup-java`) and the Android
  SDK command-line tools. `./gradlew` in the generated project will
  pull what else it needs on first run.

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

To populate `CYB_ASC_KEY_P8_BASE64`:
```bash
base64 -i ~/.appstoreconnect/AuthKey_XXXXXXXXXX.p8 | pbcopy
# Paste into Settings → Secrets and variables → Actions → New repository secret
```

Android release builds (when Android lands) will additionally want a
Google Play service-account JSON.

## Debugging a failed CI run

- **`playwright-report-*`** artifact has the HTML report with traces,
  screenshots, and videos.
- **`playwright-test-results-*`** artifact has the raw per-test
  directories (trace.zip, video.webm) for replaying in the Playwright UI.
- Supabase container logs are printed inline in the job output — expand
  the "Supabase logs on failure" step.
