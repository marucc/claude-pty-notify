#!/bin/zsh
# claude launcher called from cmux etc.
# Starts claude through src/wrapper.ts (passes straight through when CLAUDE_PTY_WRAPPED is set)
claude_bin="$(readlink -f ~/.local/bin/claude)"
if [[ ! -x "$claude_bin" ]]; then
  echo "claude-pty-notify: ~/.local/bin/claude not found (install Claude Code with the official installer)" >&2
  exit 1
fi

# A project can pin an older Node (mise etc.) that cannot run TypeScript; run claude without the wrapper there
if [[ -n "$CLAUDE_PTY_WRAPPED" ]] || ! node -e 'process.exit(process.features.typescript ? 0 : 1)' 2>/dev/null; then
  exec "$claude_bin" "$@"
fi
exec node "${0:A:h}/src/wrapper.ts" "$@"
