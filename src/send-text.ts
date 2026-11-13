export const DEFAULT_ALLOWED_COMMANDS = ["session-init", "status-sync", "compact", "clear", "ping"];

const MAX_TEXT_CODEPOINTS = 4000;
// C0 controls except \t and \n (ESC, NUL, \r included), DEL, C1 controls, U+2028 / U+2029
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f\u2028\u2029]/;
// Format characters (zero-width, bidi controls, BOM) and lone surrogates
const FORMAT_RE = /[\p{Cf}\p{Cs}]/u;
const LEADING_WHITESPACE_RE = /^\p{White_Space}/u;
// Words that Claude runs as /exit when they make up the whole input (compared trimmed and case-insensitive)
const EXIT_WORDS = new Set(["exit", "quit", ":q", ":q!", ":wq", ":wq!"]);

// Whether text may be pasted into the prompt as-is
// The mode-switching first characters (! shell, # memory) and non-allowlisted slash commands are rejected
export function isAcceptableText(text: unknown, allowedCommands: ReadonlySet<string>): text is string {
  if (typeof text !== "string") return false;
  const length = [...text].length;
  if (length < 1 || length > MAX_TEXT_CODEPOINTS) return false;
  if (CONTROL_RE.test(text) || FORMAT_RE.test(text)) return false;
  if (LEADING_WHITESPACE_RE.test(text)) return false;
  if (text.startsWith("!") || text.startsWith("#")) return false;
  if (EXIT_WORDS.has(text.trim().toLowerCase())) return false;
  // Claude treats Enter after a trailing backslash as a newline, so the text would stay unsent in the input line
  if (text.endsWith("\\")) return false;
  if (text.startsWith("/")) {
    if (text.includes("\n")) return false;
    const command = text.slice(1).split(/\s/u, 1)[0];
    return allowedCommands.has(command);
  }
  return true;
}
