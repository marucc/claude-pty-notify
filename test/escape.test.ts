import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTrailingEscape } from "../src/escape.ts";

test("splitTrailingEscape keeps a complete chunk as is", () => {
  assert.deepEqual(splitTrailingEscape("abc\x1b]0;✳ demo\x07"), ["abc\x1b]0;✳ demo\x07", ""]);
});

test("splitTrailingEscape holds a lone ESC", () => {
  assert.deepEqual(splitTrailingEscape("abc\x1b"), ["abc", "\x1b"]);
});

test("splitTrailingEscape holds an unterminated CSI", () => {
  assert.deepEqual(splitTrailingEscape("abc\x1b[?100"), ["abc", "\x1b[?100"]);
});

test("splitTrailingEscape holds an unterminated OSC title", () => {
  assert.deepEqual(splitTrailingEscape("abc\x1b]0;✳ de"), ["abc", "\x1b]0;✳ de"]);
});

test("splitTrailingEscape holds an OSC title cut inside its ST terminator", () => {
  assert.deepEqual(splitTrailingEscape("abc\x1b]0;✳ demo\x1b"), ["abc", "\x1b]0;✳ demo\x1b"]);
});

test("splitTrailingEscape passes through an overly long unterminated sequence", () => {
  const chunk = "\x1b]52;c;" + "A".repeat(5000);
  assert.deepEqual(splitTrailingEscape(chunk), [chunk, ""]);
});
