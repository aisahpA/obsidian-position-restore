#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------
# vault 目录（vault 根目录）从 reload.local.sh 里读（git-ignored，见 .gitignore）。
# 建一次即可：
#   echo 'VAULT_DIR=/path/to/vault' > reload.local.sh
# 环境变量仍然优先：VAULT_DIR=/path/to/vault bash reload.sh
# 其余（vault 名、插件 id、插件目录）都是推导出来的。
# 默认（prod）→ 生产构建（npm run build，压缩、无 sourcemap）。
# 第一参数 "dev" → 一次性 dev 构建、带内联 sourcemap（同 npm run dev，但不 watch）。
# ------------------------------------------------------------------
VAULT_DIR="${VAULT_DIR:-}"

# 项目目录 = 本脚本所在目录（构建产物写到它下面的 "dist"）
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 本地（git-ignored）配置：reload.local.sh 可以设置 VAULT_DIR 等。
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
# `dist/` 就是插件（见 esbuild.config.mjs）：main.js、manifest.json 和构建出的
# 样式表，全部由刚跑完的那次构建产出。项目根只放源码 —— 那里的 styles.css 是手写
# 的那个，注释都还在。
for f in main.js manifest.json styles.css; do
  cp "$PROJECT_DIR/dist/$f" "$PLUGIN_DIR/$f"
done

echo "→ Reloading Obsidian plugin $PLUGIN_ID ..."
obsidian plugin:reload "vault=$VAULT" "id=$PLUGIN_ID"

echo "✓ Built and reloaded."