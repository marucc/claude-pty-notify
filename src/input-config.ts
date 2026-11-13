import os from "node:os";
import path from "node:path";
import { DEFAULT_ALLOWED_COMMANDS } from "./send-text.ts";

// Variables read by the input socket; they are removed from the environment of the child claude
export const INPUT_ENV_KEYS = [
  "CLAUDE_PTY_NO_INPUT",
  "CLAUDE_PTY_RUN_DIR",
  "CLAUDE_PTY_TYPING_GUARD_MS",
  "CLAUDE_PTY_MAX_CONNECTIONS",
  "CLAUDE_PTY_CONNECTION_TIMEOUT_MS",
  "CLAUDE_PTY_DIALOG_HOLD_MS",
  "CLAUDE_PTY_ALLOWED_COMMANDS",
] as const;

export interface InputConfig {
  disabled: boolean;
  runDir: string;
  typingGuardMs: number;
  maxConnections: number;
  connectionTimeoutMs: number;
  dialogHoldMs: number;
  allowedCommands: Set<string>;
}

type Env = Record<string, string | undefined>;

// Integer in [min, max]; the default (with a warning) for anything else, so a guard cannot be disabled with 0 or a negative value
function intFromEnv(env: Env, key: string, def: number, min: number, max: number, warn: (msg: string) => void): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
  warn(`${key}=${JSON.stringify(raw)} is not an integer in ${min}-${max}; using ${def}`);
  return def;
}

function allowedCommands(env: Env, warn: (msg: string) => void): Set<string> {
  const commands = new Set(DEFAULT_ALLOWED_COMMANDS);
  const raw = env.CLAUDE_PTY_ALLOWED_COMMANDS;
  if (!raw) return commands;
  for (const item of raw.split(",")) {
    const command = item.trim().replace(/^\//, "");
    if (command === "" || /[\s/]/u.test(command)) {
      warn(`CLAUDE_PTY_ALLOWED_COMMANDS: ignoring invalid entry ${JSON.stringify(item)}`);
      continue;
    }
    commands.add(command);
  }
  return commands;
}

export function loadInputConfig(env: Env, warn: (msg: string) => void): InputConfig {
  return {
    disabled: noInput(env, warn),
    runDir: env.CLAUDE_PTY_RUN_DIR || path.join(os.homedir(), ".claude", "run"),
    typingGuardMs: intFromEnv(env, "CLAUDE_PTY_TYPING_GUARD_MS", 3000, 1000, 60000, warn),
    maxConnections: intFromEnv(env, "CLAUDE_PTY_MAX_CONNECTIONS", 8, 1, 32, warn),
    connectionTimeoutMs: intFromEnv(env, "CLAUDE_PTY_CONNECTION_TIMEOUT_MS", 5000, 1000, 60000, warn),
    dialogHoldMs: intFromEnv(env, "CLAUDE_PTY_DIALOG_HOLD_MS", 30000, 5000, 600000, warn),
    allowedCommands: allowedCommands(env, warn),
  };
}

export function childEnv(env: Env): Env {
  const rest = { ...env };
  for (const key of INPUT_ENV_KEYS) delete rest[key];
  return rest;
}

// Only "1" disables the socket; any other non-empty value other than "0" is probably a mistake worth a warning
function noInput(env: Env, warn: (msg: string) => void): boolean {
  const raw = env.CLAUDE_PTY_NO_INPUT;
  if (raw === "1") return true;
  if (raw !== undefined && raw !== "" && raw !== "0") warn(`CLAUDE_PTY_NO_INPUT=${JSON.stringify(raw)} is not 1; the input socket stays enabled`);
  return false;
}
