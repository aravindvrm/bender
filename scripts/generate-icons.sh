#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ICON_DIR="$ROOT_DIR/build/icons"
PUBLIC_DIR="$ROOT_DIR/src/web/public"
ICONSET_DIR="$ICON_DIR/icon.iconset"
MASTER_PNG="$ICON_DIR/icon-1024.png"

mkdir -p "$ICON_DIR" "$PUBLIC_DIR"

swift "$ROOT_DIR/scripts/generate-icons.swift" "$ROOT_DIR" >/dev/null

cp "$MASTER_PNG" "$ICON_DIR/icon.png"
sips -z 64 64 "$MASTER_PNG" --out "$PUBLIC_DIR/favicon.png" >/dev/null

cat > "$PUBLIC_DIR/favicon.svg" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="20" fill="#d4d4d8"/>
  <text x="64" y="84" fill="#09090b" font-size="84" text-anchor="middle" font-family="Doto, monospace" font-weight="800">B</text>
</svg>
EOF

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

sips -z 16 16 "$MASTER_PNG" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$MASTER_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$MASTER_PNG" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$MASTER_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$MASTER_PNG" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$MASTER_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$MASTER_PNG" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$MASTER_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$MASTER_PNG" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$MASTER_PNG" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null

# Remove AppleDouble sidecar files that make iconutil fail on external volumes.
find "$ICON_DIR" -name '._*' -delete

iconutil -c icns "$ICONSET_DIR" -o "$ICON_DIR/icon.icns"

echo "Generated icon assets:"
echo "- $ICON_DIR/icon-1024.png"
echo "- $ICON_DIR/icon.png"
echo "- $ICON_DIR/icon.icns"
echo "- $PUBLIC_DIR/favicon.png"
echo "- $PUBLIC_DIR/favicon.svg"
