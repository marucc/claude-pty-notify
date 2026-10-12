#!/usr/bin/env node
/**
 * Claude PTY wrapper
 *
 * Runs Claude inside a PTY and intercepts title changes sent via OSC escape sequences.
 * When the title switches to ✳ (waiting), sends a notification to the terminal via OSC 777.
 * A ✳ state showing a permission or question dialog is shown with PERMISSION_MARKER until the user responds.
 * While unfocused, rewrites the title of an unacknowledged waiting state to UNREAD_MARKER.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node-pty";
import { resolveMessages, formatMessage, unreadMarker, permissionMarker } from "./message.ts";
import { promptKind, type PromptKind } from "./permission.ts";
import { isResponseInput } from "./input.ts";
import { splitTrailingEscape } from "./escape.ts";

// OSC 0/2 title sequence: \x1b]0;TITLE\x07 or \x1b]0;TITLE\x1b\\
const OSC_TITLE_RE = /\x1b\](?:0|2);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

const WAITING_MARKER = "✳";
// Marker for a waiting state the user has not seen yet
const UNREAD_MARKER = unreadMarker(process.env);
// Marker shown while Claude waits for tool permission or an answer
const PERMISSION_MARKER = permissionMarker(process.env);
// Resolved before spawning so a broken locale file fails at startup
const MESSAGES = resolveMessages(process.env);

// The permission dialog is printed a few ms after the title switches to ✳,
// so wait this long before deciding between waiting for input and waiting for permission
const DECISION_DELAY_MS = 500;
// Upper bound of the output kept for permission prompt detection
const RECENT_OUTPUT_LIMIT = 16 * 1024;

const DEBUG = process.env.CLAUDE_PTY_DEBUG === "1";
const LOG_FILE = process.env.CLAUDE_PTY_LOG; // e.g. CLAUDE_PTY_LOG=/tmp/pty.log claude
// Opened before spawning so an unwritable path fails at startup
const logFd = LOG_FILE ? fs.openSync(LOG_FILE, "a") : null;

function dbg(msg: string): void {
  if (logFd === null && !DEBUG) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  if (logFd !== null) {
    fs.writeSync(logFd, line);
  } else {
    process.stderr.write(line);
  }
}

// Return a JSON string with control characters made visible (for logging)
function vis(str: string): string {
  return JSON.stringify(str);
}

// Notification suppression patterns (one per line in ~/.claude/no-notify-sessions)
const NO_NOTIFY_FILE = path.join(os.homedir(), ".claude", "no-notify-sessions");
const noNotifyPatterns = ((): string[] => {
  try {
    return fs.readFileSync(NO_NOTIFY_FILE, "utf8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
})();

// The official installer creates a symlink at ~/.local/bin/claude
// Spawn the real binary it points to directly (no login shell needed)
// The calling shell already has PATH set up (mise etc.), so the inherited environment is fine
const claudeBin = fs.realpathSync(path.join(os.homedir(), ".local", "bin", "claude"));
const claudeArgs = process.argv.slice(2);

function exitCodeOf(exitCode: number | null, signal: NodeJS.Signals | number | null | undefined): number {
  if (!signal) return exitCode ?? 1;
  const signalNumber = typeof signal === "number" ? signal : os.constants.signals[signal];
  return 128 + signalNumber;
}

// Not attached to a terminal (e.g. `echo x | claude -p`): there is no title or focus to watch
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  const result = spawnSync(claudeBin, claudeArgs, { stdio: "inherit" });
  process.exit(exitCodeOf(result.status, result.signal));
}

// Focus / visibility tracking
// Assume focused at startup (switches to unfocused on the first \x1b[O)
let isFocused = true;
// If a focus event is written to the child before claude puts the PTY in raw mode,
// the PTY echo returns ^[[I (4 literal characters).
// Forward focus events only after the first OSC title (claude has finished starting).
let childReady = false;
// Last title emitted by Claude (before any marker rewrite)
let lastClaudeTitle = "";
// Whether the user has focused and seen the current ✳ state
// Once acknowledged, losing focus during the same ✳ episode does not show the unread marker
let acknowledged = false;
// Whether the previous Claude title was ✳ (to detect the non-✳ → ✳ transition)
let prevWasWaiting = false;
// Dialog the current ✳ state is blocked on
let blockingPrompt: PromptKind | null = null;
// Child output since the current ✳ state started (or the user last answered)
let recentOutput = "";
// Timer that decides the kind of the current ✳ state
let decisionTimer: NodeJS.Timeout | null = null;

// Build an OSC title sequence
function oscTitle(title: string): string {
  return `\x1b]0;${title}\x07`;
}

// Title to show for a title emitted by Claude
function displayTitle(title: string): string {
  if (!title.startsWith(WAITING_MARKER)) return title;
  if (blockingPrompt) return title.replace(WAITING_MARKER, PERMISSION_MARKER);
  if (!isFocused && !acknowledged) return title.replace(WAITING_MARKER, UNREAD_MARKER);
  return title;
}

function appendOutput(text: string): void {
  recentOutput = (recentOutput + text).slice(-RECENT_OUTPUT_LIMIT);
}

function cancelDecision(): void {
  if (decisionTimer) clearTimeout(decisionTimer);
  decisionTimer = null;
}

// Decide whether the current ✳ state is waiting for input, permission, or an answer, then notify
function decideWaitingKind(): void {
  cancelDecision();
  blockingPrompt = promptKind(recentOutput);
  dbg(`decide: prompt=${blockingPrompt}`);
  if (blockingPrompt) {
    process.stdout.write(oscTitle(displayTitle(lastClaudeTitle)));
  }

  // Send a notification to the terminal (OSC 777 notify)
  // Skip when CLAUDE_NO_NOTIFY=1 or the session matches no-notify-sessions
  const sessionName = lastClaudeTitle.replace(WAITING_MARKER, "").trim();
  const suppressed = process.env.CLAUDE_NO_NOTIFY ||
    noNotifyPatterns.some(p => sessionName.toLowerCase().includes(p.toLowerCase()));
  if (!suppressed) {
    const text = formatMessage(MESSAGES[blockingPrompt ?? "waiting"], sessionName);
    process.stdout.write(`\x1b]777;notify;Claude Code;${text}\x07`);
  }
}

// The user answered in the tab (approve / reject / new input)
function handleResponseInput(): void {
  const shownBefore = displayTitle(lastClaudeTitle);
  recentOutput = "";
  acknowledged = true;
  // Already typing before the decision: no need to notify
  if (decisionTimer) {
    cancelDecision();
    dbg("user input → decision cancelled");
  }
  if (blockingPrompt) {
    blockingPrompt = null;
    dbg("user input → prompt cleared");
  }
  const shown = displayTitle(lastClaudeTitle);
  if (shown !== shownBefore) process.stdout.write(oscTitle(shown));
}

function handleTitleChange(title: string): void {
  lastClaudeTitle = title;
  const isWaiting = title.startsWith(WAITING_MARKER);

  // First OSC title = claude has already put the PTY in raw mode
  // From here on, focus events can be safely forwarded to the child
  if (!childReady) {
    childReady = true;
    dbg("childReady=true (first OSC title received)");
    // Send the focus state that may have changed during startup
    child.write(isFocused ? "\x1b[I" : "\x1b[O");
    // The ✳ shown right after startup is not worth a notification
    if (isWaiting) {
      prevWasWaiting = true;
      acknowledged = true;
      return;
    }
  }

  // Busy again: the previous waiting episode (including a dialog) is over
  if (!isWaiting) {
    recentOutput = "";
    blockingPrompt = null;
    cancelDecision();
  }

  // non-✳ → ✳ transition = start of a new waiting episode
  // If already focused, the user sees it immediately, so treat it as acknowledged
  if (isWaiting && !prevWasWaiting) {
    acknowledged = isFocused;
    // Dialogs are printed after the ✳ title; earlier output is Claude's reply,
    // which may itself contain "Do you want to ..."
    recentOutput = "";
    decisionTimer = setTimeout(decideWaitingKind, DECISION_DELAY_MS);
  }
  prevWasWaiting = isWaiting;
}

const child = (() => {
  try {
    return spawn(claudeBin, claudeArgs, {
      name: "xterm-256color",
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_PTY_WRAPPED: "1" },
    });
  } catch (e) {
    console.error(`claude-pty-notify: failed to start ${claudeBin}: ${(e as Error).message}`);
    console.error("If it says posix_spawnp failed, run `npm ci` in claude-pty-notify to restore the executable bit on node-pty's spawn-helper");
    process.exit(1);
  }
})();

// Incomplete escape sequence at the end of the previous chunk, prepended to the next one
let escBuf = "";

// Intercept output, detect title changes, and rewrite them when needed
child.onData((data) => {
  dbg(`child.onData raw=${vis(data)}`);

  const [complete, held] = splitTrailingEscape(escBuf + data);
  escBuf = held;
  if (held) dbg(`partial escape held: ${vis(held)}`);

  // Strip focus events and focus reporting control from the child PTY
  const text = complete
    .replace(/\x1b\[\?1004[hl]/g, "") // focus reporting enable/disable
    .replace(/\x1b\[I/g, "")          // focus in
    .replace(/\x1b\[O/g, "");         // focus out

  // Process titles in order, keeping the text between them in order too,
  // so a busy title only clears the output before it
  let textStart = 0;
  const output = text.replace(OSC_TITLE_RE, (sequence: string, title: string, offset: number) => {
    appendOutput(text.slice(textStart, offset));
    textStart = offset + sequence.length;

    dbg(`title: ${vis(title)} focused=${isFocused} ack=${acknowledged} prompt=${blockingPrompt}`);
    handleTitleChange(title);

    // Replace ✳ with the permission / unread marker when needed
    const shown = displayTitle(title);
    if (shown === title) return sequence;
    dbg(`rewrite → ${vis(shown)}`);
    return oscTitle(shown);
  });
  appendOutput(text.slice(textStart));

  dbg(`stdout.write=${vis(output)}`);
  process.stdout.write(output);

  // Switch to the permission marker as soon as the dialog shows up instead of waiting for the timer
  // (after writing the chunk, so its ✳ / unread title does not overwrite the marker)
  if (decisionTimer && promptKind(recentOutput)) {
    decideWaitingKind();
  }
});

child.onExit(({ exitCode, signal }) => {
  process.exit(exitCodeOf(exitCode, signal));
});

// Turn off the focus reporting enabled below, or the shell keeps receiving ^[[I / ^[[O after exit
process.on("exit", () => {
  fs.writeSync(1, "\x1b[?1004l");
});

// Put stdin in raw mode first
// (prevents the \x1b[I that arrives right after enabling focus reporting from being echoed as ^[[I in cooked mode)
process.stdin.setRawMode(true);

// Enable focus reporting (makes the terminal send \x1b[I / \x1b[O)
dbg("focus reporting enabled");
process.stdout.write("\x1b[?1004h");
process.stdin.on("data", (data: Buffer) => {
  const str = data.toString("binary");
  dbg(`stdin.onData raw=${vis(str)}`);

  // The last focus event wins when several arrive in one read
  const focusIn = str.lastIndexOf("\x1b[I");
  const focusOut = str.lastIndexOf("\x1b[O");
  if (focusIn > focusOut) {
    isFocused = true;
    if (lastClaudeTitle.startsWith(WAITING_MARKER)) {
      // Mark the ✳ state as acknowledged → no unread marker on later focus loss
      acknowledged = true;
      // Remove the unread marker (the permission marker stays until the prompt is handled)
      const shown = displayTitle(lastClaudeTitle);
      process.stdout.write(oscTitle(shown));
      dbg(`focus in → ack=true, show ${vis(shown)}`);
    }
  } else if (focusOut > focusIn) {
    isFocused = false;
    // Unacknowledged ✳ → switch to the unread marker
    if (lastClaudeTitle.startsWith(WAITING_MARKER) && !acknowledged) {
      const shown = displayTitle(lastClaudeTitle);
      process.stdout.write(oscTitle(shown));
      dbg(`focus out → show ${vis(shown)}`);
    }
  }

  // Terminal replies, mouse events and arrow keys also arrive on stdin; only answering input counts
  if (isResponseInput(str)) handleResponseInput();

  // Forward focus events only after childReady (before that, the PTY echo prints ^[[I)
  const isFocusEvent = focusIn >= 0 || focusOut >= 0;
  if (!isFocusEvent || childReady) {
    child.write(data);
  }
});

// Propagate terminal resizes to the PTY
process.stdout.on("resize", () => {
  child.resize(process.stdout.columns, process.stdout.rows);
});

// Signal handling
process.on("SIGINT", () => {}); // Claude handles SIGINT
process.on("SIGTERM", () => child.kill());
