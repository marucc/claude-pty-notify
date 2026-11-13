import { test } from "node:test";
import assert from "node:assert/strict";
import { INPUT_ENV_KEYS, childEnv, loadInputConfig } from "../src/input-config.ts";

function load(env: Record<string, string>) {
  const warnings: string[] = [];
  return { config: loadInputConfig(env, m => warnings.push(m)), warnings };
}

test("loadInputConfig returns defaults", () => {
  const { config, warnings } = load({});
  assert.equal(config.disabled, false);
  assert.match(config.runDir, /\.claude\/run$/);
  assert.equal(config.typingGuardMs, 3000);
  assert.equal(config.maxConnections, 8);
  assert.equal(config.connectionTimeoutMs, 5000);
  assert.equal(config.dialogHoldMs, 30000);
  assert.ok(config.allowedCommands.has("compact"));
  assert.deepEqual(warnings, []);
});

test("loadInputConfig reads valid values", () => {
  const { config, warnings } = load({
    CLAUDE_PTY_NO_INPUT: "1",
    CLAUDE_PTY_RUN_DIR: "/x",
    CLAUDE_PTY_TYPING_GUARD_MS: "1000",
    CLAUDE_PTY_MAX_CONNECTIONS: "32",
    CLAUDE_PTY_CONNECTION_TIMEOUT_MS: "60000",
    CLAUDE_PTY_DIALOG_HOLD_MS: "5000",
  });
  assert.equal(config.disabled, true);
  assert.equal(config.runDir, "/x");
  assert.equal(config.typingGuardMs, 1000);
  assert.equal(config.maxConnections, 32);
  assert.equal(config.connectionTimeoutMs, 60000);
  assert.equal(config.dialogHoldMs, 5000);
  assert.deepEqual(warnings, []);
});

test("loadInputConfig falls back to defaults with a warning for bad numbers", () => {
  for (const [key, value] of [
    ["CLAUDE_PTY_TYPING_GUARD_MS", "0"],
    ["CLAUDE_PTY_TYPING_GUARD_MS", "-5"],
    ["CLAUDE_PTY_TYPING_GUARD_MS", "999"],
    ["CLAUDE_PTY_MAX_CONNECTIONS", "33"],
    ["CLAUDE_PTY_CONNECTION_TIMEOUT_MS", "1.5"],
    ["CLAUDE_PTY_DIALOG_HOLD_MS", "abc"],
  ]) {
    const { config, warnings } = load({ [key]: value });
    assert.equal(warnings.length, 1, `${key}=${value}`);
    assert.equal(config.typingGuardMs, 3000);
    assert.equal(config.maxConnections, 8);
    assert.equal(config.connectionTimeoutMs, 5000);
    assert.equal(config.dialogHoldMs, 30000);
  }
});

test("loadInputConfig adds allowed commands and warns about invalid entries", () => {
  const { config, warnings } = load({ CLAUDE_PTY_ALLOWED_COMMANDS: " /foo , bar,, a b, c/d " });
  assert.ok(config.allowedCommands.has("foo"));
  assert.ok(config.allowedCommands.has("bar"));
  assert.ok(config.allowedCommands.has("compact"));
  assert.equal(warnings.length, 3);
});

test("childEnv removes the input socket variables only", () => {
  const env: Record<string, string> = { CLAUDE_PTY_LOG: "/l", CLAUDE_PTY_DEBUG: "1", PATH: "/bin" };
  for (const key of INPUT_ENV_KEYS) env[key] = "1";
  assert.deepEqual(childEnv(env), { CLAUDE_PTY_LOG: "/l", CLAUDE_PTY_DEBUG: "1", PATH: "/bin" });
});

test("loadInputConfig warns when CLAUDE_PTY_NO_INPUT is neither 1, 0 nor empty", () => {
  for (const value of ["true", "yes", "2"]) {
    const { config, warnings } = load({ CLAUDE_PTY_NO_INPUT: value });
    assert.equal(config.disabled, false);
    assert.equal(warnings.length, 1, value);
  }
  for (const value of ["0", ""]) {
    assert.deepEqual(load({ CLAUDE_PTY_NO_INPUT: value }).warnings, []);
  }
});
