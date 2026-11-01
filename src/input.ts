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
  /\x1b(?:\[(?:1;[0-9]+)?|O)[ABCD]/g, // arrow keys (with modifiers)
];

// Whether stdin data contains something the user typed to answer (characters, Enter, Esc, paste)
export function isResponseInput(data: string): boolean {
  const rest = NON_RESPONSE_RES.reduce((s, re) => s.replace(re, ""), data);
  return rest.length > 0;
}
