#!/usr/bin/env bash
# One-time setup on the cyb-mac runner Mac. Installs the keychain-unlock
# LaunchAgent so codesign keeps working after reboots / long idle periods,
# even when no one is actively at the keyboard.
#
# Idempotent: re-running just reinstalls + reloads the agent. The password
# step is the only interactive part — it'll prompt once.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="app.cookyourbooks.unlock-keychain"
PLIST_SRC="$REPO_ROOT/scripts/runner/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE="cyb-mac-runner-keychain-unlock"

if [ ! -f "$PLIST_SRC" ]; then
  echo "Missing $PLIST_SRC"
  exit 1
fi

# Step 1: stash login password in the user keychain (skip if already set).
if security find-generic-password -a "$USER" -s "$SERVICE" -w >/dev/null 2>&1; then
  echo "✓ keychain entry '$SERVICE' already exists"
else
  echo "Enter your Mac LOGIN PASSWORD (used to unlock the keychain at runner startup)."
  echo "It will be stored in your user keychain under service '$SERVICE',"
  echo "readable only by /usr/bin/security (no UI prompt at unlock time)."
  read -rs -p "Login password: " PASSWORD
  echo
  security add-generic-password \
    -a "$USER" \
    -s "$SERVICE" \
    -w "$PASSWORD" \
    -T /usr/bin/security
  unset PASSWORD
  echo "✓ stored password in keychain under service '$SERVICE'"
fi

# Step 2: install + load the LaunchAgent.
mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DST"
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "✓ loaded LaunchAgent $LABEL"

# Step 3: run it once now so the keychain is unlocked immediately.
"$REPO_ROOT/scripts/runner/unlock-keychain.sh"
echo
echo "Done. Logs: ~/Library/Logs/cyb-mac-runner.log"
echo "Verify: security show-keychain-info ~/Library/Keychains/login.keychain-db"
