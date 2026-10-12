# claude-pty-notify

English | [日本語](README_ja.md)

Wraps Claude Code in a PTY and sends terminal notifications when it is waiting for input, without using hooks.

When hooks are disabled by managed settings, hook-based notifications (cmux's Claude integration, Notification hooks, etc.) do not work. claude-pty-notify only watches the terminal title and screen output emitted by Claude Code, so it works whether hooks are available or not.

## Features

- **Waiting-for-input notification**: when the title switches to `✳` (waiting for input), sends a notification via OSC 777. Terminals such as cmux and Ghostty show it as a desktop notification. No notification for the `✳` right after startup, or when you have already started typing
- **Permission / question detection**: when Claude Code shows a permission dialog ("Do you want to ...") or a question with choices (`AskUserQuestion`, detected by "Chat about this"), the title shows `▶` and the notification says it needs permission / is waiting for an answer. The marker stays until you respond in the tab (arrow keys that only move the selection do not count)
- **Unread marker**: while unfocused, rewrites the title of a waiting session you have not seen yet from `✳` to `✦`. It goes back to `✳` when you focus the tab
- **Notification suppression**: sessions matching patterns in `~/.claude/no-notify-sessions` are not notified
- **Notification language**: chosen from the locale (`LC_ALL` → `LC_MESSAGES` → `LANG`). English and Japanese are included; other languages fall back to English
- **Fallbacks**: when stdin / stdout is not a terminal (e.g. `claude -p` in a pipe), the wrapper runs claude directly. `shim.sh` also runs claude without the wrapper when the `node` resolved in the current directory cannot run TypeScript (e.g. a project pinning an older Node with mise)

## Requirements

- macOS
- Node.js 22.18 or later (runs the TypeScript sources directly)
- Claude Code installed with the official installer at `~/.local/bin/claude`
- A terminal that supports OSC 777 and focus reporting (`\x1b[?1004h`), such as cmux or Ghostty

## Setup

```bash
git clone https://github.com/marucc/claude-pty-notify.git
cd claude-pty-notify
./install.sh
```

This installs dependencies and sets executable permissions. It does not modify your shell config files, so add the printed snippet yourself.

### With cmux

cmux's shell integration overrides the `claude` function, so a `claude` function defined in `.zshrc` is not used. Point `CMUX_CUSTOM_CLAUDE_PATH` at `shim.sh` instead.

```zsh
export CMUX_CUSTOM_CLAUDE_PATH="/path/to/claude-pty-notify/shim.sh"
```

The `--settings` / `--mcp-config` arguments added by cmux are passed through to Claude Code as is.

### Without cmux

```zsh
claude() {
  if [[ -n "$CLAUDE_PTY_WRAPPED" ]]; then
    command claude "$@"
  else
    node /path/to/claude-pty-notify/src/wrapper.ts "$@"
  fi
}
```

## Suppressing notifications

Write one pattern per line in `~/.claude/no-notify-sessions`. A session is not notified when its name (the title without `✳`) contains a pattern, case-insensitively. Lines starting with `#` are comments.

```
# Do not notify monitoring sessions
monitor
```

Start with `CLAUDE_NO_NOTIFY=1` to suppress all notifications for that session.

## Customizing markers

| Variable | State | Default |
|---|---|---|
| `CLAUDE_PTY_UNREAD_MARKER` | Waiting for input, not seen yet | `✦` |
| `CLAUDE_PTY_PERMISSION_MARKER` | Waiting for permission or an answer | `▶` |

For example, to use the Nerd Font bell (Nerd Font icons are drawn wider than one cell, so add a trailing space):

```zsh
export CLAUDE_PTY_UNREAD_MARKER=$'\U000F009A '
```

## Adding a language

Add `locales/<language>.json` with the same keys as `locales/en.json`. `{session}` is replaced with the session name.

```json
{
  "waiting": "{session} is waiting for input",
  "permission": "{session} needs permission",
  "question": "{session} is waiting for an answer"
}
```

For `pt_BR.UTF-8`, `pt_BR.json` is tried first, then `pt.json`, then `en.json`. `npm test` checks that every locale file has all keys.

## Debugging

```bash
CLAUDE_PTY_DEBUG=1 claude               # log to stderr
CLAUDE_PTY_LOG=/path/to/pty.log claude  # log to a file
```

## Development

```bash
npm ci             # includes typescript and @types/node
npm test           # node --test test/*.test.ts
npm run typecheck  # tsc (no emit)
```

## Limitations

- Permission waits are detected from the dialog text ("Do you want to ..."). If Claude Code changes the wording, they are treated as waiting for input. Only output after the title switches to `✳` is checked, so Claude's reply itself is not misdetected
- The question dialog is detected by its "Chat about this" option. If Claude Code changes the wording, it is treated as waiting for input
- Stops working if Claude Code changes how it sets the terminal title

## License

MIT
