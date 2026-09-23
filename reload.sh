#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------
# Vault folder (the vault root directory) is read from reload.local.sh
# (git-ignored, see .gitignore). Create it once:
#   echo 'VAULT_DIR=/path/to/vault' > reload.local.sh
# Env still wins: VAULT_DIR=/path/to/vault bash reload.sh
# Everything else (vault name, plugin id, plugin dir) is derived.
# Default (prod) → production build (npm run build, minified, no sourcemap).
# First arg "dev" → one-shot dev build with inline sourcemap (like npm run dev, but no watch).
# ------------------------------------------------------------------
VAULT_DIR="${VAULT_DIR:-}"

# Project directory = directory of this script (the build writes to "dist" below it)
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

BUILD_MODE="${1:-prod}"
if [ "$BUILD_MODE" != "prod" ] && [ "$BUILD_MODE" != "dev" ]; then
  echo "Error: unknown build mode '$BUILD_MODE' (expected: prod or dev)." >&2
  exit 1
fi

echo "→ Building plugin ($PLUGIN_ID, mode=$BUILD_MODE) ..."
if [ "$BUILD_MODE" = "dev" ]; then
  node esbuild.config.mjs
else
  npm run build
fi

echo "→ Copying build outputs to $PLUGIN_DIR ..."
mkdir -p "$PLUGIN_DIR"
# `dist/` is the plugin (see esbuild.config.mjs): main.js, manifest.json and the
# built stylesheet, all made by the build that just ran. The project root holds
# sources only — styles.css there is the hand-written one, comments and all.
for f in main.js manifest.json styles.css; do
  cp "$PROJECT_DIR/dist/$f" "$PLUGIN_DIR/$f"
done

echo "→ Reloading Obsidian plugin $PLUGIN_ID ..."
obsidian plugin:reload "vault=$VAULT" "id=$PLUGIN_ID"

echo "✓ Built and reloaded."