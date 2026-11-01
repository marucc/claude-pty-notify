#!/bin/zsh
# claude launcher called from cmux etc.
# Starts claude through src/wrapper.ts (passes straight through when CLAUDE_PTY_WRAPPED is set)
claude_bin="$(readlink -f ~/.local/bin/claude)"
if [[ ! -x "$claude_bin" ]]; then
  echo "claude-pty-notify: ~/.local/bin/claude not found (install Claude Code with the official installer)" >&2
  exit 1
fi

# Replace a name given to -r / --resume with the session ID of its newest transcript (UUIDs and unknown names pass through)
resolver="${0:A:h}/src/resolve-session.sh"
args=("$@")
for (( i = 1; i <= $#args; i++ )); do
  case "${args[i]}" in
    -r|--resume)
      [[ -n "${args[i+1]-}" && "${args[i+1]}" != -* ]] || continue
      id="$("$resolver" "${args[i+1]}")" && args[i+1]="$id"
      ;;
    --resume=*)
      id="$("$resolver" "${args[i]#--resume=}")" && args[i]="--resume=$id"
      ;;
  esac
done

# A project can pin an older Node (mise etc.) that cannot run TypeScript; run claude without the wrapper there
if [[ -n "$CLAUDE_PTY_WRAPPED" ]] || ! node -e 'process.exit(process.features.typescript ? 0 : 1)' 2>/dev/null; then
  exec "$claude_bin" "${args[@]}"
fi
exec node "${0:A:h}/src/wrapper.ts" "${args[@]}"
