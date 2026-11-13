import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { isAcceptableText } from "./send-text.ts";
import type { Failure } from "./send-guard.ts";
import { checkRunDir, cleanStaleSockets, isOwnSocket, reapIfStale } from "./socket-files.ts";
import { socketFileName, socketStem } from "./socket-path.ts";

const MAX_LINE_BYTES = 16 * 1024;
const RECHECK_DELAY_MS = 50;
const LINGER_MS = 1000;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

type ErrorCode = "blocked" | "user_typing" | "not_ready" | "bad_request" | "too_large" | "busy" | "timeout";
type Reason = Failure["reason"] | "pasted" | "internal" | "bad_text" | "bad_json" | "too_large" | "busy" | "timeout";

interface Refusal {
  ok: false;
  error: ErrorCode;
  reason: Reason;
  retryable: boolean;
  pasted?: true;
}
type Response = { ok: true } | Refusal | Record<string, unknown>;

// Live state of the wrapper that the socket reports and checks
export interface InputHost {
  info(): {
    title: string | null;
    state: string;
    dialogSuspected: boolean;
    draftSuspected: boolean;
    lastOutputAt: number | null;
    lastInputAt: number | null;
  };
  check(recheck: boolean): Failure | null;
  write(data: string): void;
  // The paste is about to be written (its echo must not count as a dialog)
  pasteStarted(text: string): void;
  // The send failed before anything landed in the prompt
  pasteAborted(): void;
  pasteLeftover(): void;
  sent(): void;
}

export interface InputSocketOptions {
  runDir: string;
  name: string | null;
  sessionId: string | null;
  pid: number;
  startedAt: Date;
  cwd: string;
  maxConnections: number;
  connectionTimeoutMs: number;
  allowedCommands: ReadonlySet<string>;
  recheckDelayMs?: number;
  host: InputHost;
  log(line: string): void;
  warn(message: string): void;
}

interface Job {
  text: string;
  conn: Connection;
  started: boolean;
  // The paste write returned, so the text may be in the prompt
  pasted: boolean;
  cancelled: boolean;
}

function refuse(error: ErrorCode, reason: Reason, retryable: boolean): Refusal {
  return { ok: false, error, reason, retryable };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class Connection {
  readonly socket: net.Socket;
  private readonly owner: InputSocket;
  private chunks: Buffer[] = [];
  private received = 0;
  private gotLine = false;
  private responded = false;
  private closed = false;
  private firstLineTimer: NodeJS.Timeout | undefined;
  private deadlineTimer: NodeJS.Timeout | undefined;
  job: Job | null = null;

  constructor(socket: net.Socket, owner: InputSocket) {
    this.socket = socket;
    this.owner = owner;
    socket.on("data", chunk => this.onData(chunk));
    socket.on("error", () => {});
    socket.on("end", () => {
      if (!this.gotLine && !this.responded) socket.destroy();
    });
    socket.on("close", () => this.onClose());
    this.firstLineTimer = setTimeout(() => socket.destroy(), owner.connectionTimeoutMs);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: Buffer): void {
    if (this.gotLine || this.responded) return;
    const newline = chunk.indexOf(0x0a);
    const lineBytes = newline < 0 ? Infinity : this.received + newline + 1;
    this.chunks.push(chunk);
    this.received += chunk.length;
    if (newline < 0 ? this.received >= MAX_LINE_BYTES : lineBytes > MAX_LINE_BYTES) {
      this.owner.logRequest(null, "too_large");
      this.respond(refuse("too_large", "too_large", false));
      return;
    }
    if (newline < 0) return;
    this.gotLine = true;
    clearTimeout(this.firstLineTimer);
    this.deadlineTimer = setTimeout(() => this.onDeadline(), this.owner.connectionTimeoutMs);
    this.owner.handleLine(this, Buffer.concat(this.chunks).subarray(0, lineBytes - 1));
  }

  private onDeadline(): void {
    const job = this.job;
    // A started send always finishes within the recheck delay and answers by itself
    if (job && job.started) return;
    if (job) job.cancelled = true;
    this.owner.logRequest(job ? [...job.text].length : null, "timeout");
    this.respond(refuse("timeout", "timeout", true));
  }

  private onClose(): void {
    this.closed = true;
    clearTimeout(this.firstLineTimer);
    clearTimeout(this.deadlineTimer);
    if (this.job && !this.job.started && !this.job.cancelled) {
      this.job.cancelled = true;
      this.owner.logRequest([...this.job.text].length, "cancelled");
    }
    this.owner.removeConnection(this);
  }

  // One response, then close (a write error such as EPIPE is ignored)
  // Input that is still arriving is read and dropped for a moment: closing with unread data resets the connection and the client could lose the response
  respond(response: Response): void {
    if (this.responded || this.closed) return;
    this.responded = true;
    clearTimeout(this.firstLineTimer);
    clearTimeout(this.deadlineTimer);
    this.socket.end(`${JSON.stringify(response)}\n`);
    this.deadlineTimer = setTimeout(() => this.socket.destroy(), LINGER_MS);
  }
}

export class InputSocket {
  readonly connectionTimeoutMs: number;
  private readonly opts: InputSocketOptions;
  private readonly conns = new Set<Connection>();
  private readonly busyConns = new Set<Connection>();
  private readonly queue: Job[] = [];
  private pumping = false;
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private ino: number | null = null;
  private closing = false;

  constructor(opts: InputSocketOptions) {
    this.opts = opts;
    this.connectionTimeoutMs = opts.connectionTimeoutMs;
  }

  get path(): string | null {
    return this.socketPath;
  }

  // Create the socket and start listening. Failures are reported with a warning and leave the wrapper working without the socket
  async start(): Promise<void> {
    const { runDir, name, pid, warn } = this.opts;
    const dirProblem = checkRunDir(runDir);
    if (dirProblem) return warn(`input socket disabled: ${dirProblem}`);

    const hashSource = name ?? String(pid);
    const stem = socketStem(name, pid);
    const file = await this.chooseFile(stem, hashSource);
    if (file === null || this.closing) return;
    this.socketPath = file;

    // allowHalfOpen: a client may shut down its write side right after the request and still read the response
    // A disconnect cannot be told from that, so a send that has not started is cancelled only by the deadline or a reset
    const server = net.createServer({ allowHalfOpen: true }, socket => this.onConnection(socket));
    this.server = server;
    const listening = new Promise<boolean>(resolve => {
      const onListenError = (e: NodeJS.ErrnoException) => {
        warn(e.code === "EADDRINUSE"
          ? `input socket disabled: ${file} was taken by another process`
          : `input socket disabled: listen failed on ${file}: ${e.message}`);
        resolve(false);
      };
      server.once("error", onListenError);
      server.once("listening", () => {
        server.removeListener("error", onListenError);
        resolve(true);
      });
    });
    const umask = process.umask(0o177);
    try {
      server.listen(file);
    } finally {
      process.umask(umask);
    }
    if (!(await listening)) {
      this.socketPath = null;
      this.server = null;
      return;
    }
    if (!this.verifyCreated(file)) return;
    server.on("error", (e: NodeJS.ErrnoException) => {
      // Running out of descriptors or an aborted connection is temporary; keep serving
      if (e.code === "EMFILE" || e.code === "ENFILE" || e.code === "ECONNABORTED") {
        this.opts.log(`input socket: accept failed: ${e.code}`);
        return;
      }
      warn(`input socket stopped: ${e.message}`);
      this.close();
    });
    cleanStaleSockets(runDir, file, (f, e) => this.opts.log(`input socket: cannot clean ${f}: ${e.message}`)).then(
      removed => removed.length > 0 && this.opts.log(`input socket: removed stale ${removed.join(", ")}`),
      (e: Error) => this.opts.log(`input socket: cleaning stale sockets failed: ${e.message}`),
    );
  }

  // Socket path to use, or null (after a warning) when none is available
  private async chooseFile(stem: string, hashSource: string): Promise<string | null> {
    const { runDir, pid, warn } = this.opts;
    // The second candidate mixes the pid into the hash so that a truncated name still differs from the first
    for (const [candidate, source] of [[stem, hashSource], [`${stem}.${pid}`, `${hashSource}.${pid}`]]) {
      const fileName = socketFileName(runDir, candidate, source);
      if (fileName === null) {
        warn(`input socket disabled: ${runDir} is too long for a socket path`);
        return null;
      }
      const file = path.join(runDir, fileName);
      let existing: fs.Stats | null = null;
      try {
        existing = fs.lstatSync(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          warn(`input socket disabled: cannot inspect ${file}: ${(e as Error).message}`);
          return null;
        }
      }
      if (existing === null) return file;
      if (!isOwnSocket(existing)) {
        warn(`input socket disabled: ${file} exists and is not a socket owned by the current user`);
        return null;
      }
      let result: Awaited<ReturnType<typeof reapIfStale>>;
      try {
        result = await reapIfStale(file);
      } catch (e) {
        warn(`input socket disabled: cannot remove stale ${file}: ${(e as Error).message}`);
        return null;
      }
      if (result === "removed" || result === "gone") return file;
      if (result === "foreign") {
        warn(`input socket disabled: ${file} exists and is not a socket owned by the current user`);
        return null;
      }
    }
    warn(`input socket disabled: ${stem}.sock and ${stem}.${pid}.sock are both in use`);
    return null;
  }

  // The created file must be our own socket with mode 0600; otherwise close() removes it (the inode is recorded either way, as it is the file we just created)
  private verifyCreated(file: string): boolean {
    try {
      const st = fs.lstatSync(file);
      if (isOwnSocket(st) && (st.mode & 0o077) === 0) {
        this.ino = st.ino;
        return true;
      }
      this.ino = st.ino;
      this.opts.warn(`input socket disabled: ${file} was created with unexpected owner or mode`);
    } catch (e) {
      this.opts.warn(`input socket disabled: cannot inspect ${file}: ${(e as Error).message}`);
    }
    this.close();
    return false;
  }

  // Stop serving and remove our socket file (only if it is still the file we created). Safe in an exit handler
  // The server handle is not closed: libuv would unlink the path by name, which could remove a socket another wrapper created under the same name
  close(): void {
    this.closing = true;
    for (const conn of [...this.conns, ...this.busyConns]) conn.socket.destroy();
    if (this.socketPath !== null && this.ino !== null) {
      try {
        if (fs.lstatSync(this.socketPath).ino === this.ino) fs.unlinkSync(this.socketPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.opts.log(`input socket: cannot remove ${this.socketPath}: ${(e as Error).message}`);
      }
    }
    this.ino = null;
    this.server?.unref();
  }

  private onConnection(socket: net.Socket): void {
    // Connections answered with busy are tracked too, and dropped silently past the limit, so a flood cannot exhaust file descriptors
    if (this.closing || this.conns.size + this.busyConns.size >= this.opts.maxConnections * 2) {
      socket.destroy();
      return;
    }
    const conn = new Connection(socket, this);
    if (this.conns.size >= this.opts.maxConnections) {
      this.busyConns.add(conn);
      this.logRequest(null, "busy");
      conn.respond(refuse("busy", "busy", true));
      return;
    }
    this.conns.add(conn);
  }

  removeConnection(conn: Connection): void {
    this.conns.delete(conn);
    this.busyConns.delete(conn);
  }

  logRequest(length: number | null, result: string): void {
    this.opts.log(`input socket: name=${JSON.stringify(this.opts.name)} len=${length ?? "-"} result=${result}`);
  }

  handleLine(conn: Connection, line: Buffer): void {
    try {
      this.processLine(conn, line);
    } catch (e) {
      this.logRequest(null, `error ${JSON.stringify((e as Error).message)}`);
      conn.respond(refuse("not_ready", "internal", false));
    }
  }

  private processLine(conn: Connection, line: Buffer): void {
    let request: unknown;
    try {
      request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    } catch {
      this.logRequest(null, "bad_json");
      return conn.respond(refuse("bad_request", "bad_json", false));
    }
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      this.logRequest(null, "bad_json");
      return conn.respond(refuse("bad_request", "bad_json", false));
    }
    const { type } = request as { type?: unknown };
    if (type === "info") return conn.respond(this.infoResponse());
    if (type !== "send") {
      this.logRequest(null, "bad_json");
      return conn.respond(refuse("bad_request", "bad_json", false));
    }
    const keys = Object.keys(request);
    const { text } = request as { text?: unknown };
    if (keys.some(k => k !== "type" && k !== "text")) {
      this.logRequest(null, "bad_json");
      return conn.respond(refuse("bad_request", "bad_json", false));
    }
    if (!isAcceptableText(text, this.opts.allowedCommands)) {
      this.logRequest(typeof text === "string" ? [...text].length : null, "bad_text");
      return conn.respond(refuse("bad_request", "bad_text", false));
    }
    const job: Job = { text, conn, started: false, pasted: false, cancelled: false };
    conn.job = job;
    this.queue.push(job);
    this.pump().catch((e: Error) => this.logRequest(null, `error ${JSON.stringify(e.message)}`));
  }

  private infoResponse(): Response {
    const { host, name, sessionId, pid, startedAt, cwd } = this.opts;
    const info = host.info();
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return {
      ok: true,
      name,
      sessionId,
      pid,
      startedAt: startedAt.toISOString(),
      cwd,
      title: info.title,
      state: info.state,
      dialogSuspected: info.dialogSuspected,
      draftSuspected: info.draftSuspected,
      lastOutputAt: iso(info.lastOutputAt),
      lastInputAt: iso(info.lastInputAt),
    };
  }

  // Sends run one at a time in arrival order
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        if (job.cancelled) continue;
        try {
          await this.runSend(job);
        } catch (e) {
          // After the paste started the text may sit in the prompt, so the client must not resend it
          const length = [...job.text].length;
          this.logRequest(length, `error ${JSON.stringify((e as Error).message)}${job.pasted ? " after paste" : ""}`);
          if (job.pasted) {
            this.opts.host.pasteLeftover();
            job.conn.respond({ ...refuse("not_ready", "pasted", false), pasted: true });
          } else {
            this.opts.host.pasteAborted();
            job.conn.respond(refuse("not_ready", "internal", false));
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  // Paste, wait, check again, then Enter. Once the paste is written the send is not cancelled when the client leaves; it goes on to Enter if the recheck passes
  private async runSend(job: Job): Promise<void> {
    const { host } = this.opts;
    const length = [...job.text].length;
    const before = host.check(false);
    if (before) {
      this.logRequest(length, `${before.error}/${before.reason}`);
      return job.conn.respond(refuse(before.error, before.reason, true));
    }
    job.started = true;
    host.pasteStarted(job.text);
    host.write(`${PASTE_START}${job.text}${PASTE_END}`);
    job.pasted = true;
    await sleep(this.opts.recheckDelayMs ?? RECHECK_DELAY_MS);
    const after = host.check(true);
    if (after) {
      host.pasteLeftover();
      this.logRequest(length, `${after.error}/${after.reason} after paste`);
      return job.conn.respond({ ...refuse(after.error, "pasted", false), pasted: true });
    }
    host.write("\r");
    host.sent();
    this.logRequest(length, "ok");
    job.conn.respond({ ok: true });
  }
}
