import { test } from "node:test";
import assert from "node:assert/strict";
import { SendGuard } from "../src/send-guard.ts";

const READY = { starting: false, deciding: false };

function guard(): SendGuard {
  const g = new SendGuard({ typingGuardMs: 3000, dialogHoldMs: 30000 });
  g.observeOutput("\x1b[?2004h");
  return g;
}

test("check passes when nothing refuses", () => {
  assert.equal(guard().check(READY, 1000, false), null);
});

test("check refuses in the documented order", () => {
  const g = new SendGuard({ typingGuardMs: 3000, dialogHoldMs: 30000 });
  g.dialogDetected(0);
  g.humanInput(0);
  g.draftChanged("set");
  assert.deepEqual(g.check({ starting: true, deciding: true }, 1, false), { error: "not_ready", reason: "starting" });
  assert.deepEqual(g.check(READY, 1, false), { error: "blocked", reason: "dialog" });
  g.dialogOver();
  assert.deepEqual(g.check({ starting: false, deciding: true }, 1, false), { error: "not_ready", reason: "deciding" });
  assert.deepEqual(g.check(READY, 1, false), { error: "not_ready", reason: "paste_disabled" });
  g.observeOutput("\x1b[?2004h");
  assert.deepEqual(g.check(READY, 1, false), { error: "user_typing", reason: "draft" });
  g.humanInput(1);
  g.draftChanged("clear");
  assert.deepEqual(g.check(READY, 1, false), { error: "user_typing", reason: "user_typing" });
  assert.equal(g.check(READY, 3002, false), null);
});

test("the typing guard includes the boundary", () => {
  const g = guard();
  g.humanInput(1000);
  g.draftChanged("clear");
  assert.equal(g.check(READY, 4000, false)?.reason, "user_typing");
  assert.equal(g.check(READY, 4001, false), null);
});

test("a recheck skips only the starting check", () => {
  const g = guard();
  assert.equal(g.check({ starting: true, deciding: false }, 1, true), null);
  assert.equal(g.check({ starting: false, deciding: true }, 1, true)?.reason, "deciding");
  g.observeOutput("\x1b[?2004l");
  assert.equal(g.check(READY, 1, true)?.reason, "paste_disabled");
});

test("dialog wording echoed by a paste that contains it does not raise the dialog flag", () => {
  const g = guard();
  g.pasteStarted("Do you want to proceed?");
  g.dialogDetected(10);
  assert.equal(g.isDialogSuspected(10), false);
  g.sent();
  g.dialogDetected(20);
  assert.equal(g.isDialogSuspected(20), true);
});

test("a dialog that shows up during an ordinary paste is still detected", () => {
  const g = guard();
  g.pasteStarted("hello");
  g.dialogDetected(10);
  assert.equal(g.check(READY, 11, true)?.reason, "dialog");
});

test("a leftover paste ends the paste window and flags a draft", () => {
  const g = guard();
  g.pasteStarted("Chat about this");
  g.pasteLeftover();
  g.dialogDetected(10);
  assert.equal(g.isDialogSuspected(10), true);
  assert.equal(g.isDraftSuspected(), true);
});

test("an aborted paste ends the paste window without a draft", () => {
  const g = guard();
  g.pasteStarted("Chat about this");
  g.pasteAborted();
  g.dialogDetected(10);
  assert.equal(g.isDialogSuspected(10), true);
  assert.equal(g.isDraftSuspected(), false);
});

test("a recheck refuses on dialog, draft and typing in that order", () => {
  const g = guard();
  g.dialogDetected(0);
  assert.equal(g.check(READY, 1, true)?.reason, "dialog");
  g.dialogOver();
  g.draftChanged("set");
  assert.equal(g.check(READY, 1, true)?.reason, "draft");
  g.draftChanged("clear");
  g.humanInput(1);
  assert.equal(g.check(READY, 1, true)?.reason, "user_typing");
  assert.equal(g.check(READY, 3002, true), null);
});

test("observeOutput keeps the last bracketed paste switch", () => {
  const g = new SendGuard({ typingGuardMs: 3000, dialogHoldMs: 30000 });
  assert.equal(g.pasteEnabled, false);
  g.observeOutput("a\x1b[?2004hb\x1b[?2004lc\x1b[?2004h");
  assert.equal(g.pasteEnabled, true);
  g.observeOutput("\x1b[?2004h\x1b[?2004l");
  assert.equal(g.pasteEnabled, false);
  g.observeOutput("plain");
  assert.equal(g.pasteEnabled, false);
});

test("a dialog clears after the hold time without new dialog text once the user answered", () => {
  const g = guard();
  g.dialogDetected(1000);
  g.humanInput(2000);
  g.draftChanged("clear");
  assert.equal(g.isDialogSuspected(31999), true);
  assert.equal(g.isDialogSuspected(32000), false);
});

test("a dialog without a user answer does not expire", () => {
  const g = guard();
  g.dialogDetected(1000);
  assert.equal(g.isDialogSuspected(10_000_000), true);
});

test("dialog text seen again extends the hold", () => {
  const g = guard();
  g.dialogDetected(1000);
  g.humanInput(2000);
  g.draftChanged("clear");
  g.dialogDetected(20000);
  assert.equal(g.isDialogSuspected(49999), true);
  assert.equal(g.isDialogSuspected(50000), false);
});

test("an answer before the dialog appears does not start the hold", () => {
  const g = guard();
  g.humanInput(100);
  g.draftChanged("clear");
  g.dialogDetected(200000);
  assert.equal(g.isDialogSuspected(400000), true);
});

test("a draft stays until Enter, Ctrl-C, Ctrl-U or a finished send", () => {
  const g = guard();
  g.humanInput(0);
  g.draftChanged("set");
  assert.equal(g.isDraftSuspected(), true);
  g.humanInput(0);
  g.draftChanged(null);
  assert.equal(g.isDraftSuspected(), true);
  g.humanInput(0);
  g.draftChanged("clear");
  assert.equal(g.isDraftSuspected(), false);
  g.pasteLeftover();
  assert.equal(g.isDraftSuspected(), true);
  g.sent();
  assert.equal(g.isDraftSuspected(), false);
});

test("lastInputAt is null until the first human input", () => {
  const g = guard();
  assert.equal(g.lastInputAt, null);
  g.humanInput(5);
  g.draftChanged("set");
  assert.equal(g.lastInputAt, 5);
});

test("Enter after a backslash typed in an earlier read keeps the draft", () => {
  const g = guard();
  g.stdinData("a", false);
  g.stdinData("\\", false);
  g.stdinData("\r", false);
  assert.equal(g.isDraftSuspected(), true);
  g.stdinData("\r", false);
  assert.equal(g.isDraftSuspected(), false);
});

test("a backslash followed by other input no longer protects the next Enter", () => {
  const g = guard();
  g.stdinData("\\", false);
  g.stdinData("b", false);
  g.stdinData("\r", false);
  assert.equal(g.isDraftSuspected(), false);
});

test("a draft raised by keys typed in a dialog is dropped when the dialog ends", () => {
  const g = guard();
  g.stdinData("1", true);
  assert.equal(g.isDraftSuspected(), true);
  g.dialogEnded();
  assert.equal(g.isDraftSuspected(), false);
});

test("a draft raised in a dialog stays when the dialog flag only expires", () => {
  const g = guard();
  g.dialogDetected(0);
  g.humanInput(1);
  g.stdinData("x", true);
  assert.equal(g.isDialogSuspected(40000), false);
  assert.equal(g.isDraftSuspected(), true);
});

test("a draft typed before the dialog survives the end of the dialog", () => {
  const g = guard();
  g.stdinData("draft", false);
  g.stdinData("1", true);
  g.dialogEnded();
  assert.equal(g.isDraftSuspected(), true);
});

test("a paste split over several reads keeps the draft until its end marker", () => {
  const g = guard();
  g.stdinData("\x1b[200~line1\r", false);
  g.stdinData("line2\r", false);
  assert.equal(g.isDraftSuspected(), true);
  g.stdinData("tail\r\x1b[201~", false);
  assert.equal(g.isDraftSuspected(), true);
  g.stdinData("\r", false);
  assert.equal(g.isDraftSuspected(), false);
});

test("a read that starts inside a paste and ends it, then types Enter, clears", () => {
  const g = guard();
  g.stdinData("\x1b[200~abc", false);
  g.stdinData("def\x1b[201~\r", false);
  assert.equal(g.isDraftSuspected(), false);
});

test("Enter that answers a dialog does not drop a draft typed before the dialog", () => {
  const g = guard();
  g.stdinData("draft", false);
  g.stdinData("\r", true);
  assert.equal(g.isDraftSuspected(), true);
});

test("Enter in a dialog clears a draft that only the dialog keys raised", () => {
  const g = guard();
  g.stdinData("1", true);
  g.stdinData("\r", true);
  assert.equal(g.isDraftSuspected(), false);
});

test("Enter in the next read after a pasted trailing backslash keeps the draft", () => {
  const g = guard();
  g.stdinData("\x1b[200~C:\\dir\\\x1b[201~", false);
  g.stdinData("\r", false);
  assert.equal(g.isDraftSuspected(), true);
});

test("Enter in the next read after a kitty backslash keeps the draft", () => {
  const g = guard();
  g.stdinData("x\x1b[92u", false);
  g.stdinData("\r", false);
  assert.equal(g.isDraftSuspected(), true);
});
