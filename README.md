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
- **Input socket**: other processes of the same user can type into the session or read its state through a Unix socket in `~/.claude/run/` (see [Input socket](#input-socket))
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

## Input socket

An interactive session creates a Unix socket in `~/.claude/run/` (directory `0700`, socket `0600`, tested on macOS only). Other processes of the same user can use it to type into the session or to read its state. One request per connection, one JSON line each way (up to 16 KiB). A client may shut down its write side after the request and still read the response; a disconnect before the response is not detected, so a send that has not started yet is cancelled only by the connection timeout.

```jsonc
{"type":"info"}
// {"ok":true,"name":"pm","sessionId":null,"pid":123,"startedAt":"…","cwd":"…","title":"…","state":"waiting","dialogSuspected":false,"draftSuspected":false,"lastOutputAt":"…","lastInputAt":null}
{"type":"send","text":"/compact"}
// {"ok":true}  or  {"ok":false,"error":"blocked","reason":"dialog","retryable":true}
```

`state` is `starting`, `permission`, `question`, `waiting` or `working`. `send` pastes the text (bracketed paste) and presses Enter. It is refused with `blocked` while a permission or question dialog may be open, with `user_typing` while the user has a draft (typed text, a pasted text or recalled history in the input line, until Enter, Ctrl-C or Ctrl-U; Esc does not clear it) or typed within the last `CLAUDE_PTY_TYPING_GUARD_MS` (3 seconds by default), and with `not_ready` before the first title, while the kind of a waiting state is still being decided, or while bracketed paste is off. Refusals carry `retryable`. A refusal after the text was pasted has `"reason":"pasted"` and `"pasted":true` (`error` keeps the kind of refusal) and must not be retried: the text stays in the input line and later sends are refused as `user_typing` until the user clears it. Other errors: `bad_request`, `too_large`, `busy` (more than the allowed connections; far more are dropped without a response), `timeout` (the request line arrived but the send did not start in time; a request line that does not arrive in time is dropped without a response) and `not_ready` with `"reason":"internal"` (an unexpected failure; not retryable). `title` in `info` has the leading marker removed and is `null` before the first title; `lastInputAt` only counts answers typed in the terminal, not arrow keys or terminal replies.

Text must be 1 to 4000 characters without control characters (tab and newline are allowed) or format characters, must not start with whitespace, `!` or `#`, must not end with a backslash, must not be just `exit`, `quit`, `:q`, `:q!`, `:wq` or `:wq!` (Claude runs these as `/exit`; compared trimmed and case-insensitive), and a leading `/` is allowed only for `session-init`, `status-sync`, `compact`, `clear` and `ping` (one line; add more with `CLAUDE_PTY_ALLOWED_COMMANDS`).

Limits: only permission dialogs and questions are recognized as dialogs. Selection menus (`/config`, `/model`, ...), plan approval and the trust-folder prompt are not, so a `send` while one is open can choose an item. A dialog is also assumed closed `CLAUDE_PTY_DIALOG_HOLD_MS` after the user last typed, and Enter may pick a highlighted file or command suggestion instead of submitting. Ctrl-U clears only the current line of a multi-line draft.

The socket is named after `-n` / `--name` (a trailing ` [hash]` removed), or `pid-<pid>.sock`. Match sessions by `name`, `sessionId` and `cwd` from `info` (`sessionId` is the UUID given to `--resume` / `-r` / `--session-id` on the command line, so it is `null` unless one of them is given; a name passed to `-r` is resolved to its UUID by `shim.sh` first. It is not updated when `/clear` or `--fork-session` changes the session id), not by file name. No socket is created for `-p` / `--print`, when stdin or stdout is not a terminal, or when it cannot be created safely (a warning is printed to stderr). Stale sockets of killed wrappers are removed at startup.

| Variable | Meaning | Default |
|---|---|---|
| `CLAUDE_PTY_NO_INPUT` | `1` disables the socket | |
| `CLAUDE_PTY_RUN_DIR` | Socket directory | `~/.claude/run` |
| `CLAUDE_PTY_ALLOWED_COMMANDS` | Extra slash commands, comma separated | |
| `CLAUDE_PTY_TYPING_GUARD_MS` | Refuse sends this long after the user typed (1000-60000) | `3000` |
| `CLAUDE_PTY_DIALOG_HOLD_MS` | How long a dialog is assumed open after the user answered it (counted from the last input or the last dialog output) without the title changing (5000-600000) | `30000` |
| `CLAUDE_PTY_MAX_CONNECTIONS` | Open connections (1-32) | `8` |
| `CLAUDE_PTY_CONNECTION_TIMEOUT_MS` | Time to receive the request line, and, separately, to start the send after it (a started send always finishes) (1000-60000) | `5000` |

These variables are not passed on to Claude. Any process of the same user can send; there is no further authentication. Claude itself (its tools run as the same user) can reach the socket too.

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
