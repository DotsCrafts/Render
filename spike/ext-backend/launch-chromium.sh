#!/usr/bin/env bash
# SPIKE: launch a DEDICATED "Google Chrome for Testing" (Playwright's binary) with
# remote debugging. This is NOT the user's system Chrome and NOT the Render window.
set -euo pipefail
CDP_PORT="${SPIKE_CDP_PORT:-19333}"
PROFILE_DIR="$(mktemp -d /tmp/spike-cft-XXXX)"
CHROME="/Users/drej/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
echo "[spike] launching dedicated Chromium for Testing on CDP port $CDP_PORT, profile $PROFILE_DIR"
exec "$CHROME" \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run --no-default-browser-check \
  --disable-background-networking \
  about:blank
