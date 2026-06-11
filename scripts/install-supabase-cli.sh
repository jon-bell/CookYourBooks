#!/usr/bin/env bash
# Downloads the Supabase CLI into ./.bin/supabase.
#
# We keep the CLI local to the repo so everyone runs the same version and
# we don't force a global install. The binary is gitignored (~100MB,
# platform-specific), so new clones + CI need to fetch it once.
#
# Usage:
#   scripts/install-supabase-cli.sh          # latest release
#   SUPABASE_CLI_VERSION=2.90.0 scripts/install-supabase-cli.sh
#
# CLI >= 2.106.0 no longer auto-exposes public schema objects through
# the Data API (local start/reset revokes the default anon/authenticated
# grants). That's fine here: the Data API grants are explicit — see
# supabase/migrations/20260701000200_explicit_data_api_grants.sql.

set -euo pipefail

VERSION="${SUPABASE_CLI_VERSION:-latest}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

case "$OS" in
  linux|darwin) ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$REPO_ROOT/.bin"

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/supabase/cli/releases/latest/download/supabase_${OS}_${ARCH}.tar.gz"
else
  URL="https://github.com/supabase/cli/releases/download/v${VERSION}/supabase_${OS}_${ARCH}.tar.gz"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching $URL"
# GitHub's release CDN occasionally 502s during traffic spikes. Retry
# a handful of times before giving up so transient hiccups don't
# wedge every CI run that lands during the bad window.
curl --retry 5 --retry-delay 3 --retry-connrefused --retry-all-errors \
  --max-time 120 \
  -fsSL "$URL" -o "$TMP/supabase.tgz"
tar -xzf "$TMP/supabase.tgz" -C "$TMP"

# Recent releases (≥ v2.100) ship two co-located binaries: `supabase` is
# a thin shim that exec's `supabase-go` from the same directory. The
# shim aborts with "Could not find the `supabase-go` binary" if you
# only place `supabase`, so install both side-by-side when present.
mv "$TMP/supabase" "$REPO_ROOT/.bin/supabase"
chmod +x "$REPO_ROOT/.bin/supabase"
if [ -f "$TMP/supabase-go" ]; then
  mv "$TMP/supabase-go" "$REPO_ROOT/.bin/supabase-go"
  chmod +x "$REPO_ROOT/.bin/supabase-go"
fi

"$REPO_ROOT/.bin/supabase" --version
