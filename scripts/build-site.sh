#!/usr/bin/env bash
# Build the landing page (site/) into a static, IPFS-ready folder: dist-site/
#
#   pnpm build:site          # build dist-site/
#   pnpm build:site --car    # also pack dist-site.car and print its root CID
#
# Everything uses relative paths, so it works from any gateway path
# (https://<gateway>/ipfs/<cid>/), a subdomain gateway, or an onchain domain's contenthash.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC=site
OUT=dist-site

rm -rf "$OUT"
mkdir -p "$OUT/assets"

cp "$SRC/index.html" "$OUT/index.html"
cp "$SRC/assets/logo.svg" "$SRC/assets/icon.png" "$OUT/assets/"
cp -R "$SRC/assets/fonts" "$OUT/assets/fonts"

# Screenshots: PNG -> WebP (much smaller) when cwebp is available, otherwise copy the PNGs as is.
if command -v cwebp >/dev/null 2>&1; then
  for png in "$SRC"/assets/*.png; do
    name=$(basename "$png" .png)
    [ "$name" = icon ] && continue
    cwebp -quiet -q 86 -m 6 "$png" -o "$OUT/assets/$name.webp"
    # rewrite references to this screenshot in the page
    sed -i '' "s#assets/$name\.png#assets/$name.webp#g" "$OUT/index.html"
  done
else
  echo "cwebp not found (brew install webp); copying PNG screenshots unchanged"
  cp "$SRC"/assets/*.png "$OUT/assets/"
fi

# Sanity check: every local asset the page references exists in the bundle.
missing=0
for ref in $( { grep -oE '(src|href|data-src)="assets/[^"]+"' "$OUT/index.html" | sed -E 's/.*="([^"]+)"/\1/'; grep -oE 'url\(assets/[^)]+\)' "$OUT/index.html" | sed -E 's/url\((.*)\)/\1/'; } | sort -u); do
  if [ ! -f "$OUT/$ref" ]; then echo "missing: $ref"; missing=1; fi
done
if grep -qE '(src|href)="/' "$OUT/index.html"; then
  echo "absolute path found; IPFS gateways need relative paths"; missing=1
fi
# Fully local: nothing may load from another host (plain links to GitHub etc. are fine).
if grep -qE '(<script[^>]+src|<link[^>]+href|url\()["(]?https?://' "$OUT/index.html"; then
  echo "external resource found; the bundle should load everything locally"; missing=1
fi
[ "$missing" = 0 ] || exit 1

echo "Built $OUT/ ($(du -sh "$OUT" | cut -f1))"

if [ "${1:-}" = "--car" ]; then
  npx --yes ipfs-car@1 pack "$OUT" --output dist-site.car
  echo "Packed dist-site.car"
fi
