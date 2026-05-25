#!/usr/bin/env bash
# Unlock the login keychain and disable its idle auto-lock for the session.
# Run by the cyb-mac runner's LaunchAgent at user login and every 30 minutes
# thereafter, so codesign can sign builds non-interactively even after a
# reboot or long idle period.
#
# Password lookup:
#   The login password is stored once via:
#     security add-generic-password \
#       -a "$USER" -s "cyb-mac-runner-keychain-unlock" \
#       -w "<your-login-password>" -T /usr/bin/security
#   (-T grants /usr/bin/security access without a UI prompt; needed so this
#   script can read the password unattended.)
#
# Exit codes: 0 on success or already-unlocked; 1 on missing password entry.

set -euo pipefail

SERVICE="cyb-mac-runner-keychain-unlock"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
LOGFILE="$HOME/Library/Logs/cyb-mac-runner.log"

mkdir -p "$(dirname "$LOGFILE")"
exec >>"$LOGFILE" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] unlock-keychain.sh starting"

PASSWORD=$(security find-generic-password -a "$USER" -s "$SERVICE" -w 2>/dev/null || true)
if [ -z "$PASSWORD" ]; then
  echo "  ERROR: no keychain entry '$SERVICE' for user $USER"
  echo "  Run scripts/runner/install-launch-agents.sh once to set it up."
  exit 1
fi

security unlock-keychain -p "$PASSWORD" "$KEYCHAIN"
# -l = no idle auto-lock for this session. Keychain stays unlocked until
# the user logs out or someone explicitly locks it.
security set-keychain-settings -l "$KEYCHAIN"

# Re-apply the ACL partition list so codesign / Apple toolchain can use
# any signing-class key in the keychain without a UI prompt. Match's
# default certs lane reimports the .p12 from the certs repo (so the
# private key churns), and a freshly-imported key's partition list is
# empty until something explicitly grants access. Without this, the
# next signed build trips errSecInternalComponent.
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$PASSWORD" \
  "$KEYCHAIN" >/dev/null 2>&1 || true

echo "  unlocked $KEYCHAIN, idle auto-lock disabled, partition list re-applied"
