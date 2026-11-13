// Up / down arrow (with modifiers): they only move the selection in a dialog, but in the prompt they recall history into the input line
const UP_DOWN_RE = /\x1b(?:\[(?:1;[0-9]+)?|O)[AB]/g;

// stdin data that does not answer a prompt: terminal replies, mouse / focus events,
// and arrow keys (they only move the selection in a dialog)
const NON_RESPONSE_RES = [
  /\x1bP[\s\S]*?\x1b\\/g,           // DCS (e.g. XTVERSION reply)
  /\x1b_[\s\S]*?\x1b\\/g,           // APC (e.g. kitty graphics reply)
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, // OSC (e.g. color query reply)
  /\x1b\[<[0-9;]*[Mm]/g,            // SGR mouse event
  /\x1b\[\?[0-9;]*[cu]/g,           // device attributes / keyboard protocol reply
  /\x1b\[\??[0-9;]*\$y/g,           // DECRQM reply
  /\x1b\[[0-9;]*[tRn]/g,            // window size / cursor position / status reply
  /\x1b\[[IO]/g,                    // focus in / out
  /\x1b(?:\[(?:1;[0-9]+)?|O)[CD]/g, // left / right arrow (with modifiers)
  UP_DOWN_RE,
];

// Tokens of typed input: paste block, kitty keyboard sequence, other CSI, Alt+key, lone Esc, any other character
const INPUT_TOKEN_RE = /\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[([0-9;:]*)u|\x1b\[[0-9;:?]*[ -\/]*[@-~]|\x1b(?=[^\x1b])[\s\S]|\x1b|[\s\S]/g;
const OTHER_CSI_RE = /^\x1b\[[0-9;:?]*[ -\/]*[@-~]$/;
const HISTORY_ARROW_RE = /^\x1b\[(?:1;[0-9]+)?[AB]$/;
// Enter, Ctrl-C, Ctrl-U (also as kitty keyboard sequences) empty or abandon the prompt line (Esc does not: it may leave the text in place)
const CLEARING_KITTY = new Set(["99;5", "117;5"]);

export type DraftEffect = "set" | "clear" | null;

// Whether the input ends in a backslash (also kitty-encoded, or just before a paste end marker)
export function trailingBackslash(data: string): boolean {
  const body = data.replace(/\x1b\[201~$/, "");
  return body.endsWith("\\") || /\x1b\[92(?:;[0-9:]*)?u$/.test(body);
}

// Effect of stdin data on the prompt line: "set" when characters / a paste / recalled history may remain in it,
// "clear" when Enter / Ctrl-C / Ctrl-U ended last, null when it does not touch the line
// Anything ambiguous counts as "set" (a false draft makes sends refuse until the user clears the line)
export function draftEffect(data: string, previousToken = ""): DraftEffect {
  const rest = NON_RESPONSE_RES.filter(re => re !== UP_DOWN_RE).reduce((s, re) => s.replace(re, ""), data);
  let effect: DraftEffect = null;
  let previous = previousToken;
  for (const m of rest.matchAll(INPUT_TOKEN_RE)) {
    const token = m[0];
    // Other control sequences (Shift+Tab, Delete, Home, End, ...) add no text; the line is as it was
    if (m[1] === undefined && OTHER_CSI_RE.test(token) && !HISTORY_ARROW_RE.test(token)) continue;
    // Enter after a backslash continues the line instead of submitting it
    const enter = (token === "\r" || m[1] === "13") && previous !== "\\";
    // Esc alone (also as a kitty sequence) leaves the line as it was
    if (token === "\x1b" || m[1] === "27") continue;
    const clearing = enter || token === "\x03" || token === "\x15" ||
      (m[1] !== undefined && CLEARING_KITTY.has(m[1]));
    effect = clearing ? "clear" : "set";
    // The line continues when the token ends in a backslash: a typed one, a kitty-encoded one (codepoint 92) or the end of a paste
    previous = trailingBackslash(token) ? "\\" : token;
  }
  return effect;
}

// Whether stdin data contains something the user typed to answer (characters, Enter, Esc, paste)
export function isResponseInput(data: string): boolean {
  const rest = NON_RESPONSE_RES.reduce((s, re) => s.replace(re, ""), data);
  return rest.length > 0;
}
