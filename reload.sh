#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------
# Vault folder (the vault root directory) is read from reload.local.sh
# (git-ignored, see .gitignore). Create it once:
#   echo 'VAULT_DIR=/path/to/vault' > reload.local.sh
# Env still wins: VAULT_DIR=/path/to/vault bash reload.sh
# Everything else (vault name, plugin id, plugin dir) is derived.
# First arg "prod" → production build (npm run build, minified, no sourcemap).
# Default (dev) → one-shot dev build with inline sourcemap (like npm run dev, but no watch).
# ------------------------------------------------------------------
VAULT_DIR="${VAULT_DIR:-}"

# Project directory = directory of this script (build output goes to "." per rollup config)
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Local (git-ignored) config: reload.local.sh may set VAULT_DIR etc.
if [ -f "$PROJECT_DIR/reload.local.sh" ]; then
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/reload.local.sh"
fi

if [ -z "${VAULT_DIR:-}" ]; then
  echo "Error: VAULT_DIR is not set." >&2
  echo "Create reload.local.sh (git-ignored) with:" >&2
  echo "  echo 'VAULT_DIR=/path/to/vault' > reload.local.sh" >&2
  echo "or run: VAULT_DIR=/path/to/vault bash reload.sh" >&2
  exit 1
fi

VAULT="$(basename "$VAULT_DIR")"
PLUGIN_ID="$(node -p "require('$PROJECT_DIR/manifest.json').id")"
PLUGIN_DIR="$VAULT_DIR/.obsidian/plugins/$PLUGIN_ID"

if ! command -v obsidian >/dev/null 2>&1; then
  echo "Error: obsidian CLI not found. Make sure "Settings > General > Command line interface" is enabled and the command is registered on your PATH." >&2
  exit 1
fi

BUILD_MODE="${1:-dev}"

echo "→ Building plugin ($PLUGIN_ID, mode=$BUILD_MODE) ..."
if [ "$BUILD_MODE" = "prod" ]; then
  npm run build
else
  npx rollup --config rollup.config.mjs
fi

echo "→ Copying build outputs to $PLUGIN_DIR ..."
mkdir -p "$PLUGIN_DIR"
for f in main.js manifest.json styles.css; do
  if [ -f "$PROJECT_DIR/$f" ]; then
    cp "$PROJECT_DIR/$f" "$PLUGIN_DIR/$f"
  fi
done

echo "→ Reloading Obsidian plugin $PLUGIN_ID ..."
obsidian plugin:reload "vault=$VAULT" "id=$PLUGIN_ID"

echo "✓ Built and reloaded."