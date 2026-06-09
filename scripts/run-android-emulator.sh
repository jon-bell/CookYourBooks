#!/usr/bin/env bash
# Build the web bundle, sync into the Android project, build the debug APK,
# install it on a running emulator/device, and launch it. Android analog of
# scripts/run-ios-sim.sh — a fast iteration loop that bypasses the Play upload
# that `fastlane beta` does.
#
#   AVD="Pixel_7_API_34" scripts/run-android-emulator.sh
#
# ── HARDWARE NOTE ─────────────────────────────────────────────────────────────
# The Android emulator needs KVM (/dev/kvm) for usable speed. Without it the
# emulator falls back to software CPU emulation (~3-5 FPS) — far too slow for a
# WebView app like this one (it loads a React SPA + cr-sqlite WASM). Headless /
# container hosts (including the CI box and most cloud workspaces) have no
# /dev/kvm, so they are BUILD-ONLY: this script still produces the APK there,
# but you must run the actual emulator on a machine that HAS KVM — a Linux box
# whose user is in the `kvm` group, or macOS/Windows using their native
# hypervisor — or plug in a physical device over `adb`.
#
# Debug the WebView from desktop Chrome at chrome://inspect → Remote Target →
# Inspect (the Android analog of the iOS "Safari → Develop → Simulator" flow).
#
# Prereqs (one-time): JDK 17 + Android SDK cmdline-tools, platform-tools,
# platforms;android-34, build-tools;34.0.0 — plus, for a local emulator,
# `emulator` + a system image and an AVD. See apps/mobile/README.md (Android).

set -euo pipefail

AVD="${AVD:-Pixel_7_API_34}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_ID="app.cookyourbooks"
MAIN_ACTIVITY="${APP_ID}/.MainActivity"

: "${ANDROID_HOME:?Set ANDROID_HOME (e.g. \$HOME/Android/sdk) — see apps/mobile/README.md (Android setup)}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

build_apk() {
  echo "==> gradlew assembleDebug"
  ( cd "$REPO_ROOT/apps/mobile/android" && ./gradlew assembleDebug --no-daemon )
}

cd "$REPO_ROOT"

echo "==> 1/5 building web + cap sync (android)"
pnpm --filter @cookyourbooks/mobile sync >/dev/null

echo "==> 2/5 ensuring a device/emulator is connected"
if ! adb get-state >/dev/null 2>&1; then
  if [ ! -e /dev/kvm ]; then
    cat >&2 <<'EOF'
[run-android-emulator] No /dev/kvm on this host and no device connected via adb.
  A software-only emulator here would run at ~3-5 FPS — unusable for a WebView app.
  Options:
    * Plug in a physical Android device (USB debugging on) — check `adb devices`.
    * Run the emulator on a workstation WITH KVM (Linux kvm group) or macOS/Windows,
      then `adb connect <host>:5555` from here.
  Building the APK only (no install/launch without a target):
EOF
    build_apk
    echo "==> APK at apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
    echo "==> install it on a real device/emulator with: adb install -r <that apk>"
    exit 0
  fi
  echo "    booting AVD: $AVD (KVM present)"
  emulator -avd "$AVD" -no-snapshot -netdelay none -netspeed full >/tmp/cyb-android-emulator.log 2>&1 &
  adb wait-for-device
  # Block until the framework is fully up before installing.
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 2
  done
fi

echo "==> 3/5 gradlew assembleDebug"
build_apk
APK="$REPO_ROOT/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
test -f "$APK" || { echo "Built APK not found at $APK"; exit 1; }

echo "==> 4/5 adb install"
adb install -r "$APK"

echo "==> 5/5 launching $MAIN_ACTIVITY"
adb shell am start -n "$MAIN_ACTIVITY"

echo "==> done. Inspect the WebView from desktop Chrome: chrome://inspect → Remote Target → Inspect"
