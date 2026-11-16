#!/usr/bin/env bash
# Build HermesChan.app and install (or update) it in /Applications.
#   pnpm install-app
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm -s package

APP="$(ls -d dist/mac*/HermesChan.app | head -1)"
[ -d "$APP" ] || { echo "build produced no HermesChan.app" >&2; exit 1; }

# Personal, unsigned build: ad-hoc sign so Apple Silicon will run it, and drop the
# quarantine flag so Gatekeeper doesn't prompt.
codesign --force --deep --sign - "$APP"
xattr -cr "$APP"

# Quit a running copy before replacing it.
if pgrep -xq HermesChan; then
  osascript -e 'tell application "HermesChan" to quit' || true
  for _ in $(seq 1 20); do pgrep -xq HermesChan || break; sleep 0.25; done
fi

rm -rf /Applications/HermesChan.app
ditto "$APP" /Applications/HermesChan.app
echo "Installed /Applications/HermesChan.app ($(git rev-parse --short HEAD 2>/dev/null || echo dev))"
