import { test } from "node:test";
import assert from "node:assert/strict";
import { isResponseInput } from "../src/input.ts";

test("isResponseInput returns true for typed characters", () => {
  assert.equal(isResponseInput("1"), true);
});

test("isResponseInput returns true for Enter", () => {
  assert.equal(isResponseInput("\r"), true);
});

test("isResponseInput returns true for Esc", () => {
  assert.equal(isResponseInput("\x1b"), true);
});

test("isResponseInput returns false for arrow keys", () => {
  for (const key of ["\x1b[A", "\x1b[B", "\x1bOC", "\x1b[1;2D"]) {
    assert.equal(isResponseInput(key), false, JSON.stringify(key));
  }
});

test("isResponseInput returns true for kitty keyboard protocol keys", () => {
  for (const key of ["\x1b[27u", "\x1b[13u", "\x1b[13;2u", "\x1b[97;1:3u"]) {
    assert.equal(isResponseInput(key), true, JSON.stringify(key));
  }
  assert.equal(isResponseInput("\x1b[?62c\x1b[27u"), true);
});

test("isResponseInput returns true for bracketed paste", () => {
  assert.equal(isResponseInput("\x1b[200~hi\x1b[201~"), true);
});

test("isResponseInput returns true when a key follows a focus event", () => {
  assert.equal(isResponseInput("\x1b[I1"), true);
});

test("isResponseInput returns false for a cursor position reply and a BEL-terminated OSC reply", () => {
  assert.equal(isResponseInput("\x1b[24;80R"), false);
  assert.equal(isResponseInput("\x1b]11;rgb:0/0/0\x07"), false);
});

test("isResponseInput returns false for mouse clicks", () => {
  assert.equal(isResponseInput("\x1b[<0;10;5M"), false);
  assert.equal(isResponseInput("\x1b[<0;10;5m"), false);
});

test("isResponseInput returns false for a mouse motion event", () => {
  assert.equal(isResponseInput("\x1b[<35;67;34M"), false);
});

test("isResponseInput returns false for focus events", () => {
  assert.equal(isResponseInput("\x1b[I"), false);
  assert.equal(isResponseInput("\x1b[O"), false);
});

test("isResponseInput returns false for terminal replies seen in cmux", () => {
  const replies = [
    "\x1bP>|ghostty 1.3.2-HEAD-+4a0e9e1\x1b\\",
    "\x1b[?5u\x1b[?62;22;52c",
    "\x1b[?2026;2$y",
    "\x1b_Gi=31;OK\x1b\\",
    "\x1b[6;31;15t",
    "\x1b[?1016;2$y",
    "\x1b]11;rgb:2828/2c2c/3434\x1b\\",
  ];
  for (const reply of replies) {
    assert.equal(isResponseInput(reply), false, JSON.stringify(reply));
  }
});

test("isResponseInput returns true when a key follows a terminal reply", () => {
  assert.equal(isResponseInput("\x1b[<35;67;34M1"), true);
});
