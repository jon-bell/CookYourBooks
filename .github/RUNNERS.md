# Self-hosted runners

CI runs on Actions Runner Controller (ARC) scale sets. Each workflow
job's `runs-on:` names the scale set directly.

## Scale sets

| Scale set label | Workflows | Status | Notes |
|---|---|---|---|
| `ripley-cloud-linux-x64` | `ci.yml`, `mobile.yml` (Capacitor sync + Android) | Active | Linux x86_64, Docker daemon available, first Supabase image pull warms the runner cache |
| `ripley-cloud-macos-pending` | `mobile.yml` (iOS) | **Pending** — scale set not yet provisioned. The iOS job is manual-dispatch only, so the placeholder label is harmless until the real pool exists | Will be renamed when the macOS scale set lands |

`runs-on:` takes a bare scale-set name rather than the traditional
`[self-hosted, linux, x64]` list — ARC attaches the scale-set name as
the runner label and ignores the legacy `self-hosted` match rules.

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

### macOS (iOS) — *when provisioned*

- Xcode 15+, CocoaPods (`sudo gem install cocoapods`).
- The workflow runs an unsigned Debug build; real release archives will
  need a signing identity + `fastlane` setup.

## Secrets

None required by `ci.yml` — the Supabase stack is started locally inside
the job. Mobile release builds will want Apple signing / Google Play
service-account secrets when those paths get fleshed out.

## Debugging a failed CI run

- **`playwright-report-*`** artifact has the HTML report with traces,
  screenshots, and videos.
- **`playwright-test-results-*`** artifact has the raw per-test
  directories (trace.zip, video.webm) for replaying in the Playwright UI.
- Supabase container logs are printed inline in the job output — expand
  the "Supabase logs on failure" step.
