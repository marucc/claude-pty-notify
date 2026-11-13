import { test } from "node:test";
import assert from "node:assert/strict";
import { draftEffect, isResponseInput, trailingBackslash } from "../src/input.ts";

test("isResponseInput returns true for typed characters", () => {
  assert.equal(isResponseInput("1"), true);
});

test("isResponseInput returns true for Enter", () => {
  assert.equal(isResponseInput("\r"), true);
});

test("isResponseInput returns true for Esc", () => {
  assert.equal(isResponseInput("\x1b"), true);
});

test("draftEffect is set for history arrows and null for left / right arrows", () => {
  for (const key of ["\x1b[A", "\x1b[B", "\x1bOA", "\x1b[1;2B"]) {
    assert.equal(draftEffect(key), "set", JSON.stringify(key));
  }
  for (const key of ["\x1b[C", "\x1b[D", "\x1bOC", "\x1b[1;2D"]) {
    assert.equal(draftEffect(key), null, JSON.stringify(key));
  }
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

test("draftEffect is null for input that does not answer", () => {
  for (const data of ["\x1b[C", "\x1b[<0;1;1M", "\x1b[I", "\x1b[?62c"]) {
    assert.equal(draftEffect(data), null, JSON.stringify(data));
  }
});

test("draftEffect is set for characters and pastes", () => {
  for (const data of ["a", "1", "\x1b[200~text\r\x1b[201~", "\x1bx", "\x1b[13;2u", "\x1b[97u", "\x7f"]) {
    assert.equal(draftEffect(data), "set", JSON.stringify(data));
  }
});

test("draftEffect is clear for Enter, Ctrl-C and Ctrl-U", () => {
  for (const data of ["\r", "\x03", "\x15", "\x1b[13u", "\x1b[99;5u", "\x1b[117;5u"]) {
    assert.equal(draftEffect(data), "clear", JSON.stringify(data));
  }
});

test("draftEffect follows the last event of one read", () => {
  assert.equal(draftEffect("abc\r"), "clear");
  assert.equal(draftEffect("\rabc"), "set");
  assert.equal(draftEffect("\x1b[200~x\x1b[201~\r"), "clear");
});

test("draftEffect keeps the draft when Enter follows a backslash", () => {
  assert.equal(draftEffect("abc\\\r"), "set");
  assert.equal(draftEffect("\\"), "set");
  assert.equal(draftEffect("\\\r\r"), "clear");
  assert.equal(draftEffect("\x1b[13u"), "clear");
});

test("draftEffect ignores control sequences that add no text", () => {
  for (const key of ["\x1b[Z", "\x1b[3~", "\x1b[H", "\x1b[F"]) {
    assert.equal(draftEffect(key), null, JSON.stringify(key));
  }
  assert.equal(draftEffect("a\x1b[Z"), "set");
});

test("draftEffect leaves the draft as it was for Esc", () => {
  assert.equal(draftEffect("\x1b"), null);
  assert.equal(draftEffect("\x1b[27u"), null);
  assert.equal(draftEffect("a\x1b"), "set");
  assert.equal(draftEffect("\x1b\x1b"), null);
});

test("draftEffect keeps the draft when a kitty Enter follows a backslash", () => {
  assert.equal(draftEffect("\x1b[13u", "\\"), "set");
  assert.equal(draftEffect("\\\x1b[13u"), "set");
  assert.equal(draftEffect("\x1b[92u\x1b[13u"), "set");
  assert.equal(draftEffect("\x1b[13u"), "clear");
});

test("draftEffect keeps the draft when Enter follows a pasted backslash", () => {
  assert.equal(draftEffect("\x1b[200~C:\\dir\\\x1b[201~\r"), "set");
  assert.equal(draftEffect("\x1b[200~a\x1b[201~\r"), "clear");
  assert.equal(draftEffect("\x1b[92;1u\x1b[13u"), "set");
});

test("trailingBackslash sees typed, kitty and pasted backslashes", () => {
  assert.equal(trailingBackslash("abc\\"), true);
  assert.equal(trailingBackslash("\x1b[92u"), true);
  assert.equal(trailingBackslash("\x1b[92;1u"), true);
  assert.equal(trailingBackslash("\x1b[200~a\\\x1b[201~"), true);
  assert.equal(trailingBackslash("abc"), false);
  assert.equal(trailingBackslash("\\a"), false);
});
