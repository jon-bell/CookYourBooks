#!/usr/bin/env bash
# Downloads the Supabase CLI into ./.bin/supabase.
#
# We keep the CLI local to the repo so everyone runs the same version and
# we don't force a global install. The binary is gitignored (~100MB,
# platform-specific), so new clones + CI need to fetch it once.
#
# Usage:
#   scripts/install-supabase-cli.sh          # pinned default
#   SUPABASE_CLI_VERSION=2.90.0 scripts/install-supabase-cli.sh
#
# The default is pinned, not "latest": CI re-fetches the CLI on every
# run, so an upstream release can break every branch with zero repo
# changes. v2.106.0 (2026-06-11) did exactly that — it flipped
# `auto_expose_new_tables` to false and made local start/reset revoke
# the anon/authenticated Data API grants on `public`, 401-ing the
# PostgREST readiness probe. Bump deliberately, after a green local
# `db reset` + e2e run. Before moving to >= 2.106.0, land explicit
# GRANTs for anon/authenticated/service_role in a migration (the
# deprecated `auto_expose_new_tables = true` escape hatch is removed
# 2026-10-30).

set -euo pipefail

VERSION="${SUPABASE_CLI_VERSION:-2.105.0}"
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
