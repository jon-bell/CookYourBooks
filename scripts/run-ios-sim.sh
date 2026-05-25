#!/usr/bin/env bash
# Build the web bundle, sync into the iOS project, build the iOS app for the
# simulator, install it, and launch it. Fast iteration loop for the
# Capacitor/iOS surface — bypasses the App Store Connect upload that
# `fastlane beta` does.
#
# Defaults to the "iPhone 17 Pro" simulator. Override with the SIM env var:
#
#   SIM="iPhone 17e" scripts/run-ios-sim.sh
#
# Prerequisites (one-time): Xcode + the iOS platform downloaded
# (`xcodebuild -downloadPlatform iOS`), CocoaPods + the node toolchain
# documented in apps/mobile/README.md.

set -euo pipefail

SIM="${SIM:-iPhone 17 Pro}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_ID="app.cookyourbooks"

# RVM in the user's shell pollutes GEM_PATH so brew-installed cocoapods +
# fastlane refuse to start. Strip its env vars defensively.
unset GEM_PATH GEM_HOME RUBY_VERSION MY_RUBY_HOME IRBRC rvm_path

# nvm is loaded as a shell function (not on PATH), so subshells like this one
# don't see Node 20. Hoist the brew-installed nvm path directly.
if [ -d "/usr/local/Cellar/nvm/0.35.3/versions/node/v20.20.2/bin" ]; then
  export PATH="/usr/local/Cellar/nvm/0.35.3/versions/node/v20.20.2/bin:$PATH"
fi
export LANG="${LANG:-en_US.UTF-8}"

cd "$REPO_ROOT"

echo "==> 1/5 building web (Vite production bundle)"
pnpm --filter @cookyourbooks/mobile sync >/dev/null

echo "==> 2/5 booting simulator: $SIM"
xcrun simctl boot "$SIM" 2>/dev/null || true
open -a Simulator

echo "==> 3/5 xcodebuild Debug for $SIM"
cd apps/mobile/ios/App
xcodebuild \
  -workspace App.xcworkspace \
  -scheme App \
  -configuration Debug \
  -destination "platform=iOS Simulator,name=$SIM" \
  CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath ./sim-build \
  -quiet \
  build

APP="$REPO_ROOT/apps/mobile/ios/App/sim-build/Build/Products/Debug-iphonesimulator/App.app"
test -d "$APP" || { echo "Built app not found at $APP"; exit 1; }

echo "==> 4/5 installing app on booted simulator"
xcrun simctl install booted "$APP"

echo "==> 5/5 launching $BUNDLE_ID"
xcrun simctl launch booted "$BUNDLE_ID"

echo "==> done. Inspect WebView via Safari: Develop → Simulator → CookYourBooks"
