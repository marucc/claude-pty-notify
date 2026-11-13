import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ALLOWED_COMMANDS, isAcceptableText } from "../src/send-text.ts";

const allowed = new Set(DEFAULT_ALLOWED_COMMANDS);
const ok = (t: unknown) => isAcceptableText(t, allowed);

test("isAcceptableText accepts plain text, newlines and tabs", () => {
  assert.equal(ok("hello"), true);
  assert.equal(ok("a\nb\tc"), true);
  assert.equal(ok("日本語 😀"), true);
});

test("isAcceptableText rejects non-strings and bad lengths", () => {
  assert.equal(ok(undefined), false);
  assert.equal(ok(1), false);
  assert.equal(ok(""), false);
  assert.equal(ok("a".repeat(4000)), true);
  assert.equal(ok("a".repeat(4001)), false);
  assert.equal(ok("😀".repeat(4000)), true);
  assert.equal(ok("😀".repeat(4001)), false);
});

test("isAcceptableText rejects control characters", () => {
  for (const c of ["\x1b", "\x00", "\r", "\x07", "\x7f", "\x85", " ", " ", "\x1b[201~"]) {
    assert.equal(ok(`a${c}b`), false, JSON.stringify(c));
  }
});

test("isAcceptableText rejects format characters and lone surrogates", () => {
  for (const c of ["​", "‮", "﻿", "⁦", "\ud800"]) {
    assert.equal(ok(`a${c}b`), false, JSON.stringify(c));
  }
});

test("isAcceptableText rejects text starting with whitespace, ! or #", () => {
  for (const t of [" a", "\na", "\ta", "　a", "!ls", "#note"]) {
    assert.equal(ok(t), false, JSON.stringify(t));
  }
});

test("isAcceptableText does not check ! and # at the start of later lines", () => {
  assert.equal(ok("a\n!b\n#c"), true);
});

test("isAcceptableText allows only listed slash commands, on one line", () => {
  assert.equal(ok("/compact"), true);
  assert.equal(ok("/session-init foo bar"), true);
  assert.equal(ok("/clear\tx"), true);
  assert.equal(ok("/exit"), false);
  assert.equal(ok("/"), false);
  assert.equal(ok("/ compact"), false);
  assert.equal(ok("/Compact"), false);
  assert.equal(ok("/compact\nmore"), false);
  assert.equal(ok("/compactx"), false);
});

test("isAcceptableText honors a custom allowlist with namespaced commands", () => {
  const custom = new Set(["plugin:ping"]);
  assert.equal(isAcceptableText("/plugin:ping x", custom), true);
  assert.equal(isAcceptableText("/ping", custom), false);
});

test("isAcceptableText rejects text ending with a backslash", () => {
  assert.equal(ok("path\\"), false);
  assert.equal(ok("a\\\nb"), true);
  assert.equal(ok("/compact \\"), false);
  assert.equal(ok("a\\b"), true);
});

test("close-worktree is not allowed by default", () => {
  assert.equal(DEFAULT_ALLOWED_COMMANDS.includes("close-worktree"), false);
  assert.equal(ok("/close-worktree x"), false);
  assert.equal(isAcceptableText("/close-worktree x", new Set(["close-worktree"])), true);
});

test("isAcceptableText rejects words Claude runs as exit", () => {
  for (const t of ["exit", "quit", ":q", ":q!", ":wq", ":wq!", "EXIT", "Quit", "exit\n", "exit\n\n", ":WQ"]) {
    assert.equal(ok(t), false, JSON.stringify(t));
  }
  assert.equal(ok("exit now"), true);
  assert.equal(ok("please exit"), true);
  assert.equal(ok("exit\nmore"), true);
});
