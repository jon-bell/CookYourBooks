# Self-hosted runner requirements

CI runs on self-hosted runners keyed by labels in the workflow files.
Any machine with the required labels + tools installed will pick up
matching jobs.

## Labels we use

| Label set | Workflows | Required tools |
|---|---|---|
| `[self-hosted, linux, x64]` | `ci.yml`, `mobile.yml` (sync + Android) | Docker (daemon running as the runner user), Node 20+, `git`, Android SDK + JDK 17 for the Android job |
| `[self-hosted, macos]` | `mobile.yml` (iOS) | Xcode 15+, Node 20+ |

You don't need Node or pnpm pre-installed; `actions/setup-node` +
`pnpm/action-setup` install them per job. Docker and Xcode you do need.

## Linux runner bring-up

1. Register the runner against the repo with labels `linux x64` in
   addition to the default `self-hosted`.
2. Install Docker and add the runner user to the `docker` group so
   `docker ps` works without `sudo`.
3. Allow port range 54420–54429 inbound on `localhost` (default).
   The Supabase stack binds to `127.0.0.1` so no external exposure is
   required.
4. First `supabase start` pulls ~1.5GB of container images from
   public.ecr.aws. They're cached across runs on the same host.
5. Playwright browsers are installed per-job via `playwright install
   --with-deps chromium`. The `--with-deps` variant may prompt for
   `sudo apt install` the first time; grant the runner user
   `NOPASSWD` sudo for `apt` or pre-install the deps out-of-band.

## macOS runner bring-up (iOS only)

Needed only if you dispatch the `mobile.yml` iOS job.

1. Xcode 15 or newer (command-line tools plus the full IDE).
2. A CocoaPods install (`sudo gem install cocoapods`) — Capacitor's iOS
   project uses it.
3. For real release builds, also install a code-signing identity and
   update the workflow to call `fastlane gym` or equivalent. The job as
   written produces an unsigned Debug binary for validation.

## Secrets

None required for `ci.yml` — everything runs against a local Supabase
stack started inside the job. `mobile.yml` release builds will need
`APPLE_TEAM_ID`, `MATCH_PASSWORD` etc. when that path gets fleshed out.

## Debugging a failed CI run

- **`playwright-report-*`** artifact (uploaded on failure) has the full
  HTML report with traces, screenshots, and videos.
- **`playwright-test-results-*`** artifact has raw per-test directories
  (trace.zip, video.webm) if you need to re-open a trace in the
  Playwright UI.
- Supabase container logs for the failing run are printed inline in the
  job output (expand the "Supabase logs on failure" step).
