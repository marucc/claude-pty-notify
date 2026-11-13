import { draftEffect, trailingBackslash, type DraftEffect } from "./input.ts";
import { promptKind } from "./permission.ts";

const PASTE_ENABLE = "\x1b[?2004h";
const PASTE_DISABLE = "\x1b[?2004l";
const PASTE_START_MARK = "\x1b[200~";
const PASTE_END_MARK = "\x1b[201~";

export type FailureError = "blocked" | "user_typing" | "not_ready";
export type FailureReason = "starting" | "dialog" | "deciding" | "paste_disabled" | "draft" | "user_typing";

export interface Failure {
  error: FailureError;
  reason: FailureReason;
}

export interface GuardContext {
  // No title received yet
  starting: boolean;
  // The title is waiting but the kind of the waiting state is not decided yet
  deciding: boolean;
}

// What the wrapper knows about the prompt, to decide whether text from the socket may be written
export class SendGuard {
  lastInputAt: number | null = null;
  pasteEnabled = false;
  private pasteInFlight = false;
  private dialogSuspected = false;
  private dialogSeenAt = 0;
  private dialogResponseAt: number | null = null;
  private draftSuspected = false;
  // The draft was raised by keys typed while a dialog was up
  private draftFromDialog = false;
  private backslashPending = false;
  // Inside a bracketed paste whose end marker has not arrived yet
  private inPaste = false;
  private readonly typingGuardMs: number;
  private readonly dialogHoldMs: number;

  constructor(opts: { typingGuardMs: number; dialogHoldMs: number }) {
    this.typingGuardMs = opts.typingGuardMs;
    this.dialogHoldMs = opts.dialogHoldMs;
  }

  // Track bracketed paste mode from child output (the last switch wins; disabled until the first one)
  observeOutput(text: string): void {
    const on = text.lastIndexOf(PASTE_ENABLE);
    const off = text.lastIndexOf(PASTE_DISABLE);
    if (on > off) this.pasteEnabled = true;
    else if (off > on) this.pasteEnabled = false;
  }

  // A permission / question dialog text showed up (or the wrapper classified the state as one)
  dialogDetected(now: number): void {
    if (this.pasteInFlight) return;
    if (!this.dialogSuspected) this.dialogResponseAt = null;
    this.dialogSuspected = true;
    this.dialogSeenAt = now;
  }

  // The dialog flag is lifted: the title left the waiting state, a new waiting episode started, or the hold time passed (the draft is left alone)
  dialogOver(): void {
    this.dialogSuspected = false;
    this.dialogResponseAt = null;
  }

  // The title left the waiting state or a new waiting episode started: the dialog is over for good, so a draft raised only by dialog keys is dropped too
  dialogEnded(): void {
    this.dialogOver();
    if (this.draftFromDialog) {
      this.draftSuspected = false;
      this.draftFromDialog = false;
    }
  }

  isDialogSuspected(now: number): boolean {
    if (this.dialogSuspected && this.dialogResponseAt !== null &&
        now - Math.max(this.dialogResponseAt, this.dialogSeenAt) >= this.dialogHoldMs) {
      this.dialogOver();
    }
    return this.dialogSuspected;
  }

  isDraftSuspected(): boolean {
    return this.draftSuspected;
  }

  // The user answered in the terminal (characters, Enter, Esc, paste)
  humanInput(now: number): void {
    this.lastInputAt = now;
    this.dialogResponseAt = now;
  }

  // Any stdin data, also keys that do not count as an answer such as history arrows
  // Input typed while a dialog is up may be an answer (a digit) that never reaches the input line, so the draft it raised is dropped when the dialog ends
  // A bracketed paste can arrive in several reads; everything up to its end marker is paste content and never clears the draft
  stdinData(data: string, inDialog: boolean): void {
    let rest = data;
    let effect: DraftEffect = null;
    if (this.inPaste) {
      const end = rest.indexOf(PASTE_END_MARK);
      effect = "set";
      if (end < 0) {
        rest = "";
      } else {
        rest = rest.slice(end + PASTE_END_MARK.length);
        this.inPaste = false;
      }
    }
    if (rest.lastIndexOf(PASTE_START_MARK) > rest.lastIndexOf(PASTE_END_MARK)) this.inPaste = true;
    effect = draftEffect(rest, this.backslashPending ? "\\" : "") ?? effect;
    if (effect === null) return;
    this.backslashPending = effect === "set" && trailingBackslash(data);
    const hadDraft = this.draftSuspected;
    // Enter in a dialog answers the dialog; it does not empty a draft that was there before the dialog
    if (effect === "clear" && inDialog && hadDraft && !this.draftFromDialog) return;
    this.draftChanged(effect);
    if (effect === "clear" || !inDialog) this.draftFromDialog = false;
    else if (!hadDraft) this.draftFromDialog = true;
  }

  // Effect of stdin data on the prompt line, from draftEffect()
  draftChanged(effect: DraftEffect): void {
    if (effect === "set") this.draftSuspected = true;
    else if (effect === "clear") this.draftSuspected = false;
  }

  // The socket is about to paste. When the text itself contains dialog wording, its echo must not raise the dialog flag
  // (any other text leaves detection on, so a real dialog that shows up during the paste is still caught by the recheck)
  pasteStarted(text: string): void {
    this.pasteInFlight = promptKind(text) !== null;
  }

  // The send failed before anything landed in the prompt
  pasteAborted(): void {
    this.pasteInFlight = false;
  }

  // The paste stayed in the prompt because the recheck refused (or a later write failed)
  pasteLeftover(): void {
    this.pasteInFlight = false;
    this.draftSuspected = true;
    this.draftFromDialog = false;
  }

  // A socket send finished with Enter
  sent(): void {
    this.pasteInFlight = false;
    this.draftSuspected = false;
    this.draftFromDialog = false;
  }

  // First refusing condition, or null. The recheck after the paste runs the same checks except for starting
  check(ctx: GuardContext, now: number, recheck: boolean): Failure | null {
    if (!recheck && ctx.starting) return { error: "not_ready", reason: "starting" };
    if (this.isDialogSuspected(now)) return { error: "blocked", reason: "dialog" };
    if (ctx.deciding) return { error: "not_ready", reason: "deciding" };
    if (!this.pasteEnabled) return { error: "not_ready", reason: "paste_disabled" };
    if (this.draftSuspected) return { error: "user_typing", reason: "draft" };
    if (this.lastInputAt !== null && now - this.lastInputAt <= this.typingGuardMs) {
      return { error: "user_typing", reason: "user_typing" };
    }
    return null;
  }
}
