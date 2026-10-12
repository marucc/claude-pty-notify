export type PromptKind = "question" | "permission";

// Fixed UI text of Claude Code's dialogs that block until the user answers
// Question (AskUserQuestion) is checked first because its question text may itself contain "Do you want to"
const QUESTION_PROMPT_RE = /Chat about this/;
// Permission dialogs start with "Do you want to ..." (e.g. "Do you want to proceed?")
const PERMISSION_PROMPT_RE = /Do you want to/;
// Cursor movement (CUF / CHA / CUP etc.); differential rendering uses it in place of spaces
const ANSI_CURSOR_MOVE_RE = /\x1b\[[0-9;]*[ABCDEFGHf]/g;
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

// Kind of blocking dialog in the output, or null
export function promptKind(output: string): PromptKind | null {
  const text = output
    .replace(ANSI_CURSOR_MOVE_RE, " ")
    .replace(ANSI_CSI_RE, "")
    .replace(/\s+/g, " ");
  if (QUESTION_PROMPT_RE.test(text)) return "question";
  if (PERMISSION_PROMPT_RE.test(text)) return "permission";
  return null;
}
