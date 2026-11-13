import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const PROBE_TIMEOUT_MS = 500;
const PROBE_RETRY_DELAY_MS = 100;
// A socket this young may still be between bind and listen; never treat it as stale
const FRESH_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Why the run directory cannot be used, or null. Creates it with 0700 when missing; the parent is not checked
export function checkRunDir(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return `${dir} is not a directory (symbolic links are not followed)`;
    if (st.uid !== process.getuid!()) return `${dir} is not owned by the current user`;
    if ((st.mode & 0o077) !== 0) return `${dir} is accessible by others (mode ${(st.mode & 0o777).toString(8)}); expected 0700`;
    return null;
  } catch (e) {
    return `cannot prepare ${dir}: ${(e as Error).message}`;
  }
}

export function isOwnSocket(st: fs.Stats): boolean {
  return st.isSocket() && st.uid === process.getuid!();
}

function connectOnce(file: string): Promise<"connected" | "refused" | "other"> {
  return new Promise(resolve => {
    const socket = net.connect(file);
    const done = (result: "connected" | "refused" | "other") => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done("other"));
    socket.once("connect", () => done("connected"));
    socket.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED" || e.code === "ENOENT" ? "refused" : "other"));
  });
}

// Whether nobody listens on the socket file
// Only two consecutive refusals (100 ms apart) mean "dead"; timeouts and other errors count as alive
export async function isSocketDead(file: string): Promise<boolean> {
  if ((await connectOnce(file)) !== "refused") return false;
  await sleep(PROBE_RETRY_DELAY_MS);
  return (await connectOnce(file)) === "refused";
}

export type ReapResult = "removed" | "alive" | "gone" | "foreign";

// Remove the socket file when it is ours, nobody listens, and it is not brand new (throws on failures other than a missing file)
// Re-checks the inode and mtime right before unlink so a socket recreated meanwhile by another wrapper survives
export async function reapIfStale(file: string, now: () => number = Date.now): Promise<ReapResult> {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw e;
  }
  if (!isOwnSocket(before)) return "foreign";
  if (!(await isSocketDead(file))) return "alive";
  if (now() - before.mtimeMs <= FRESH_MS) return "alive";
  try {
    const again = fs.lstatSync(file);
    if (again.ino !== before.ino || again.mtimeMs !== before.mtimeMs || now() - again.mtimeMs <= FRESH_MS) return "alive";
    fs.unlinkSync(file);
    return "removed";
  } catch (e) {
    // Other failures (permissions, I/O) are reported to the caller
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw e;
  }
}

// Remove stale sockets of ours in the run directory, one at a time (own socket excluded)
export async function cleanStaleSockets(dir: string, own: string, onError: (file: string, e: Error) => void = () => {}): Promise<string[]> {
  const removed: string[] = [];
  const names = fs.readdirSync(dir).filter(n => n.endsWith(".sock"));
  for (const name of names) {
    const file = path.join(dir, name);
    if (file === own) continue;
    try {
      if ((await reapIfStale(file)) === "removed") removed.push(file);
    } catch (e) {
      onError(file, e as Error);
    }
  }
  return removed;
}
