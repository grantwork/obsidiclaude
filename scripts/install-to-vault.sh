#!/usr/bin/env bash
# Copy the built plugin into one or more Obsidian vaults.
# Usage: scripts/install-to-vault.sh /path/to/vault [/path/to/another ...]
# Run `npm run build` first.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for f in main.js styles.css manifest.json; do
  [ -f "$ROOT/$f" ] || { echo "Missing $f. Run: npm run build" >&2; exit 1; }
done
for VAULT in "$@"; do
  [ -d "$VAULT/.obsidian" ] || { echo "Not a vault: $VAULT" >&2; exit 1; }
  DEST="$VAULT/.obsidian/plugins/obsidiclaude"
  mkdir -p "$DEST"
  cp "$ROOT/main.js" "$ROOT/styles.css" "$ROOT/manifest.json" "$DEST/"
  echo "Installed to $DEST"
done
