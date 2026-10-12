#!/bin/bash
# Setup for claude-pty-notify
set -euo pipefail

cd "$(dirname "$0")"
REPO_DIR="$(pwd -P)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node not found" >&2
  exit 1
fi

# src/*.ts is run directly, which needs Node's built-in TypeScript support (22.18+)
if ! node -e 'process.exit(process.features.typescript ? 0 : 1)'; then
  echo "Error: Node.js $(node -v) cannot run TypeScript directly. Update to Node.js 22.18 or later" >&2
  exit 1
fi

if [[ ! -e "$HOME/.local/bin/claude" ]]; then
  echo "Error: ~/.local/bin/claude not found (install Claude Code with the official installer)" >&2
  exit 1
fi

# postinstall in package.json restores the executable bit on node-pty's spawn-helper
echo "Installing dependencies"
npm ci --omit=dev

echo "Setting executable permissions"
chmod +x src/wrapper.ts shim.sh

echo "Setup complete"
echo
echo "To use with cmux, add this to your .zshrc:"
echo "  export CMUX_CUSTOM_CLAUDE_PATH=\"$REPO_DIR/shim.sh\""
