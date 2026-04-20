#!/usr/bin/env bash
# Downloads the Supabase CLI into ./.bin/supabase.
#
# We keep the CLI local to the repo so everyone runs the same version and
# we don't force a global install. The binary is gitignored (~100MB,
# platform-specific), so new clones + CI need to fetch it once.
#
# Usage:
#   scripts/install-supabase-cli.sh          # pick sensible defaults
#   SUPABASE_CLI_VERSION=2.90.0 scripts/install-supabase-cli.sh

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
curl -fsSL "$URL" -o "$TMP/supabase.tgz"
tar -xzf "$TMP/supabase.tgz" -C "$TMP"
mv "$TMP/supabase" "$REPO_ROOT/.bin/supabase"
chmod +x "$REPO_ROOT/.bin/supabase"

"$REPO_ROOT/.bin/supabase" --version
