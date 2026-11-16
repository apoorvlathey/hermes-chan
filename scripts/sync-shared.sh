#!/usr/bin/env bash
# Re-vendor Hermes's renderer-free gateway client (@hermes/shared) from a local hermes-agent checkout.
# Run after `hermes update` if the gateway protocol changed.
set -euo pipefail
SRC="${HERMES_AGENT_DIR:-$HOME/.hermes/hermes-agent}/apps/shared/src"
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor/hermes-shared"
[ -d "$SRC" ] || { echo "no hermes-agent checkout at $SRC" >&2; exit 1; }
rsync -a --delete --exclude '*.test.ts' --exclude '__snapshots__' "$SRC/" "$DEST/"
cp "$SRC/../../../LICENSE" "$DEST/LICENSE"
git -C "$SRC" rev-parse --short HEAD > "$DEST/VENDORED_FROM"
echo "vendored @hermes/shared @ $(cat "$DEST/VENDORED_FROM")"
