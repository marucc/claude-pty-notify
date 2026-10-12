// Incomplete escape sequence at the end of a chunk: lone ESC, unterminated CSI, or unterminated OSC
const TRAILING_ESCAPE_RE = /\x1b(?:\[[0-9;?]*|\][^\x07\x1b]*\x1b?)?$/;
// Longer unterminated sequences are passed through instead of being held forever
const MAX_HELD_LENGTH = 4096;

// Split a chunk into the part to process now and the trailing part to prepend to the next chunk
export function splitTrailingEscape(chunk: string): [string, string] {
  const match = chunk.match(TRAILING_ESCAPE_RE);
  if (!match || match[0].length > MAX_HELD_LENGTH) return [chunk, ""];
  return [chunk.slice(0, match.index), match[0]];
}
