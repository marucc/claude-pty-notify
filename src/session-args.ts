const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SESSION_ID_FLAGS = new Set(["--resume", "-r", "--session-id"]);
const HASH_SUFFIX_RE = /\s\[[A-Za-z0-9]+\]$/;

export interface SessionArgs {
  name: string | null;
  sessionId: string | null;
}

// Arguments before a bare "--" (everything after it is the prompt)
function optionArgs(args: readonly string[]): readonly string[] {
  const end = args.indexOf("--");
  return end < 0 ? args : args.slice(0, end);
}

function normalizeName(value: string | undefined): string | null {
  if (!value) return null;
  const name = value.replace(HASH_SUFFIX_RE, "");
  return name === "" ? null : name;
}

// Session name (-n / --name, last one wins) and session id (--resume / -r / --session-id, last UUID wins)
export function parseSessionArgs(args: readonly string[]): SessionArgs {
  const opts = optionArgs(args);
  let nameSeen = false;
  let rawName: string | undefined;
  let sessionId: string | null = null;
  for (let i = 0; i < opts.length; i++) {
    const arg = opts[i];
    if (arg === "-n" || arg === "--name") {
      nameSeen = true;
      rawName = opts[i + 1];
      i++;
    } else if (arg.startsWith("--name=")) {
      nameSeen = true;
      rawName = arg.slice("--name=".length);
    } else if (SESSION_ID_FLAGS.has(arg) && UUID_RE.test(opts[i + 1] ?? "")) {
      sessionId = opts[i + 1];
      i++;
    }
  }
  return { name: nameSeen ? normalizeName(rawName) : null, sessionId };
}

// -p / --print / --print=<value> before "--" (also matched in a value position, to be safe)
export function isPrintMode(args: readonly string[]): boolean {
  return optionArgs(args).some(a => a === "-p" || a === "--print" || a.startsWith("--print="));
}
