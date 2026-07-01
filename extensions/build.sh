#!/usr/bin/env bash
# Copies shared/content.js and shared/icons into each browser's extension folder.
# Run this after editing shared/content.js.
#   chmod +x build.sh
#   ./build.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

for BROWSER in firefox chrome edge; do
  DEST="$SCRIPT_DIR/$BROWSER"
  cp "$SCRIPT_DIR/shared/content.js" "$DEST/content.js"
  cp "$SCRIPT_DIR/shared/popup.html" "$DEST/popup.html"
  cp "$SCRIPT_DIR/shared/popup.js"   "$DEST/popup.js"
  mkdir -p "$DEST/icons"
  cp "$SCRIPT_DIR/shared/icons/"* "$DEST/icons/" 2>/dev/null || true
  echo "✓ $BROWSER"
done

echo "Done. Load extensions/$BROWSER/ in your browser's extension dev page."
