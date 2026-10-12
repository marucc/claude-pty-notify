import { test } from "node:test";
import assert from "node:assert/strict";
import { promptKind } from "../src/permission.ts";

test("promptKind detects the Bash permission dialog", () => {
  const output = "\x1b[38;2;80;80;80m╌╌╌╌\x1b[39m\r\n Do you want to proceed?\r ❯1. Yes\r   2. No\r\rEsc to cancel";
  assert.equal(promptKind(output), "permission");
});

test("promptKind detects the permission dialog when ANSI codes split the words", () => {
  assert.equal(promptKind("Do you\x1b[1m want\x1b[22m to make this edit?"), "permission");
});

test("promptKind detects the permission dialog when cursor moves replace spaces", () => {
  const output = "\r\x1b[1C\x1b[1BDo\x1b[5Gyou\x1b[9Gwant\x1b[14Gto\x1b[17Gproceed?\x1b[130G   \r";
  assert.equal(promptKind(output), "permission");
});

test("promptKind detects the question dialog", () => {
  const output = "❯ 1. A\r\n  4. Type something.\r\n\x1b[1C5.\x1b[5GChat\x1b[10Gabout\x1b[16Gthis\r\n";
  assert.equal(promptKind(output), "question");
});

test("promptKind prefers question when the question text contains the permission phrase", () => {
  assert.equal(promptKind("Do you want to use A?\r\n 1. A\r\n 5. Chat about this"), "question");
});

test("promptKind returns null for ordinary output", () => {
  assert.equal(promptKind("\x1b[2K> \x1b[7m \x1b[27m\r\n? for shortcuts"), null);
});

test("promptKind returns null for empty output", () => {
  assert.equal(promptKind(""), null);
});
