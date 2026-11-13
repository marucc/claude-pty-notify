import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { InputSocket, type InputHost, type InputSocketOptions } from "../src/input-socket.ts";
import type { Failure } from "../src/send-guard.ts";
import { DEFAULT_ALLOWED_COMMANDS } from "../src/send-text.ts";
import { leaveStale, tmpDir } from "./helpers.ts";

interface FakeHost extends InputHost {
  writes: string[];
  events: string[];
  failBefore: Failure | null;
  failAfter: Failure | null;
  throwOnWrite: number | null;
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    writes: [],
    events: [],
    failBefore: null,
    failAfter: null,
    throwOnWrite: null,
    info: () => ({
      title: "my task",
      state: "waiting",
      dialogSuspected: false,
      draftSuspected: false,
      lastOutputAt: Date.UTC(2026, 10, 14, 0, 0, 0),
      lastInputAt: null,
    }),
    check: recheck => (recheck ? host.failAfter : host.failBefore),
    write: data => {
      if (host.throwOnWrite === host.writes.length + 1) throw new Error("write failed");
      host.writes.push(data);
    },
    pasteStarted: () => host.events.push("pasteStarted"),
    pasteAborted: () => host.events.push("aborted"),
    pasteLeftover: () => host.events.push("leftover"),
    sent: () => host.events.push("sent"),
  };
  return host;
}

interface Setup {
  dir: string;
  host: FakeHost;
  warnings: string[];
  logs: string[];
  socket: InputSocket;
}

function setup(overrides: Partial<InputSocketOptions> = {}, dir = tmpDir(), host = fakeHost()): Setup {
  const warnings: string[] = [];
  const logs: string[] = [];
  const socket = new InputSocket({
    runDir: dir,
    name: "pm",
    sessionId: null,
    pid: process.pid,
    startedAt: new Date(Date.UTC(2026, 10, 14)),
    cwd: "/work",
    maxConnections: 8,
    connectionTimeoutMs: 2000,
    allowedCommands: new Set(DEFAULT_ALLOWED_COMMANDS),
    recheckDelayMs: 5,
    host,
    log: l => logs.push(l),
    warn: w => warnings.push(w),
    ...overrides,
  });
  return { dir, host, warnings, logs, socket };
}

// Send raw bytes and read until the server closes; null when it closes without a response
function exchange(file: string, payload: string | Buffer, opts: { end?: boolean } = {}): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    const client = net.connect(file);
    let data = "";
    client.setEncoding("utf8");
    client.on("data", d => (data += d));
    client.on("error", () => {});
    client.on("close", () => resolve(data === "" ? null : JSON.parse(data)));
    client.write(payload, () => opts.end && client.end());
  });
}

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

test("start creates a 0600 socket in a 0700 directory and close removes it", async () => {
  const { dir, socket, warnings } = setup();
  await socket.start();
  const file = path.join(dir, "pm.sock");
  assert.deepEqual(warnings, []);
  assert.equal(socket.path, file);
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  socket.close();
  assert.equal(fs.existsSync(file), false);
});

test("close does not remove a socket another wrapper created under the same name", async () => {
  const { dir, socket } = setup();
  await socket.start();
  const file = path.join(dir, "pm.sock");
  fs.unlinkSync(file);
  fs.writeFileSync(file, "other");
  socket.close();
  assert.equal(fs.readFileSync(file, "utf8"), "other");
});

test("info returns the session fields", async () => {
  const { dir, socket } = setup({ sessionId: "123e4567-e89b-12d3-a456-426614174000" });
  await socket.start();
  const res = await exchange(path.join(dir, "pm.sock"), line({ type: "info" }));
  assert.deepEqual(res, {
    ok: true,
    name: "pm",
    sessionId: "123e4567-e89b-12d3-a456-426614174000",
    pid: process.pid,
    startedAt: "2026-11-14T00:00:00.000Z",
    cwd: "/work",
    title: "my task",
    state: "waiting",
    dialogSuspected: false,
    draftSuspected: false,
    lastOutputAt: "2026-11-14T00:00:00.000Z",
    lastInputAt: null,
  });
  socket.close();
});

test("send pastes the text, then writes Enter separately", async () => {
  const { dir, host, socket, logs } = setup();
  await socket.start();
  const res = await exchange(path.join(dir, "pm.sock"), line({ type: "send", text: "hello" }));
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(host.writes, ["\x1b[200~hello\x1b[201~", "\r"]);
  assert.deepEqual(host.events, ["pasteStarted", "sent"]);
  assert.ok(logs.some(l => l.includes("len=5") && l.includes("result=ok")));
  assert.ok(logs.every(l => !l.includes("hello")));
  socket.close();
});

test("send is refused before writing when the check fails", async () => {
  const { dir, host, socket } = setup();
  host.failBefore = { error: "blocked", reason: "dialog" };
  await socket.start();
  const res = await exchange(path.join(dir, "pm.sock"), line({ type: "send", text: "hello" }));
  assert.deepEqual(res, { ok: false, error: "blocked", reason: "dialog", retryable: true });
  assert.deepEqual(host.writes, []);
  socket.close();
});

test("send refused by the recheck leaves the paste, flags a draft and is not retryable", async () => {
  const { dir, host, socket } = setup();
  host.failAfter = { error: "user_typing", reason: "user_typing" };
  await socket.start();
  const res = await exchange(path.join(dir, "pm.sock"), line({ type: "send", text: "hello" }));
  assert.deepEqual(res, { ok: false, error: "user_typing", reason: "pasted", retryable: false, pasted: true });
  assert.deepEqual(host.writes, ["\x1b[200~hello\x1b[201~"]);
  assert.deepEqual(host.events, ["pasteStarted", "leftover"]);
  socket.close();
});

test("invalid requests get bad_request without echoing input", async () => {
  const { dir, host, socket, logs } = setup();
  await socket.start();
  const file = path.join(dir, "pm.sock");
  const cases: [string, string][] = [
    ["not json secret\n", "bad_json"],
    ["[1]\n", "bad_json"],
    [line({ type: "nope" }), "bad_json"],
    [line({ type: "send", text: "x", submit: true }), "bad_json"],
    [line({ type: "send" }), "bad_text"],
    [line({ type: "send", text: "" }), "bad_text"],
    [line({ type: "send", text: "!ls" }), "bad_text"],
    [line({ type: "send", text: "/exit" }), "bad_text"],
    [line({ type: "send", text: "a\x1b[201~b" }), "bad_text"],
  ];
  for (const [payload, reason] of cases) {
    const res = await exchange(file, payload);
    assert.deepEqual(res, { ok: false, error: "bad_request", reason, retryable: false }, payload);
  }
  assert.deepEqual(host.writes, []);
  assert.ok(logs.every(l => !l.includes("secret") && !l.includes("!ls")));
  socket.close();
});

test("a request over 16 KiB gets too_large", async () => {
  const { dir, socket } = setup();
  await socket.start();
  const file = path.join(dir, "pm.sock");
  const withNewline = await exchange(file, line({ type: "send", text: "a".repeat(17000) }));
  assert.equal(withNewline?.error, "too_large");
  const noNewline = await exchange(file, "x".repeat(16 * 1024));
  assert.equal(noNewline?.error, "too_large");
  socket.close();
});

test("a line of exactly 16 KiB including the newline is accepted for parsing", async () => {
  const { dir, socket } = setup();
  await socket.start();
  const pad = 16 * 1024 - 1 - line({ type: "info", pad: "" }).length + 1;
  const payload = JSON.stringify({ type: "info", pad: "p".repeat(pad) }) + "\n";
  assert.equal(Buffer.byteLength(payload), 16 * 1024);
  const res = await exchange(path.join(dir, "pm.sock"), payload);
  assert.equal(res?.ok, true);
  socket.close();
});

test("a connection that closes without a newline gets no response", async () => {
  const { dir, host, socket } = setup();
  await socket.start();
  const res = await exchange(path.join(dir, "pm.sock"), JSON.stringify({ type: "send", text: "hi" }), { end: true });
  assert.equal(res, null);
  assert.deepEqual(host.writes, []);
  socket.close();
});

test("only the first line of a request is processed", async () => {
  const { dir, host, socket } = setup();
  await socket.start();
  const payload = line({ type: "send", text: "one" }) + line({ type: "send", text: "two" });
  const res = await exchange(path.join(dir, "pm.sock"), payload);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(host.writes, ["\x1b[200~one\x1b[201~", "\r"]);
  socket.close();
});

test("sends from several connections are written one at a time in arrival order", async () => {
  const { dir, host, socket } = setup({ recheckDelayMs: 30 });
  await socket.start();
  const file = path.join(dir, "pm.sock");
  const first = exchange(file, line({ type: "send", text: "one" }));
  await new Promise(r => setTimeout(r, 10));
  const second = exchange(file, line({ type: "send", text: "two" }));
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  assert.deepEqual(host.writes, ["\x1b[200~one\x1b[201~", "\r", "\x1b[200~two\x1b[201~", "\r"]);
  socket.close();
});

test("a queued send past the deadline is cancelled with timeout and never written", async () => {
  const { dir, host, socket } = setup({ recheckDelayMs: 400, connectionTimeoutMs: 100 });
  await socket.start();
  const file = path.join(dir, "pm.sock");
  const first = exchange(file, line({ type: "send", text: "one" }));
  await new Promise(r => setTimeout(r, 20));
  const second = await exchange(file, line({ type: "send", text: "two" }));
  assert.deepEqual(second, { ok: false, error: "timeout", reason: "timeout", retryable: true });
  assert.deepEqual(await first, { ok: true });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(host.writes, ["\x1b[200~one\x1b[201~", "\r"]);
  socket.close();
});


test("a send already pasted is finished even if the client leaves", async () => {
  const { dir, host, socket, logs } = setup({ recheckDelayMs: 80 });
  await socket.start();
  const client = net.connect(path.join(dir, "pm.sock"));
  client.on("error", () => {});
  client.write(line({ type: "send", text: "one" }));
  await new Promise(r => setTimeout(r, 30));
  client.destroy();
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(host.writes, ["\x1b[200~one\x1b[201~", "\r"]);
  assert.ok(logs.some(l => l.includes("result=ok")));
  socket.close();
});

test("the connection over the limit gets busy, including idle info connections", async () => {
  const { dir, socket } = setup({ maxConnections: 2 });
  await socket.start();
  const file = path.join(dir, "pm.sock");
  const idle = [net.connect(file), net.connect(file)];
  idle.forEach(c => c.on("error", () => {}));
  await new Promise(r => setTimeout(r, 50));
  const res = await exchange(file, line({ type: "info" }));
  assert.deepEqual(res, { ok: false, error: "busy", reason: "busy", retryable: true });
  idle.forEach(c => c.destroy());
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await exchange(file, line({ type: "info" })))?.ok, true);
  socket.close();
});

test("a connection that sends nothing is closed after the timeout", async () => {
  const { dir, socket } = setup({ connectionTimeoutMs: 100 });
  await socket.start();
  const closed = new Promise<void>(resolve => {
    const client = net.connect(path.join(dir, "pm.sock"));
    client.on("error", () => {});
    client.on("close", () => resolve());
  });
  await closed;
  socket.close();
});

test("a name collision with a live socket falls back to <name>.<pid>.sock, then gives up", async () => {
  const dir = tmpDir();
  const a = setup({}, dir);
  const b = setup({}, dir);
  const c = setup({}, dir);
  await a.socket.start();
  await b.socket.start();
  assert.equal(b.socket.path, path.join(dir, `pm.${process.pid}.sock`));
  await c.socket.start();
  assert.equal(c.socket.path, null);
  assert.match(c.warnings[0], /in use/);
  c.socket.close();
  b.socket.close();
  a.socket.close();
});

test("a session without a name uses the pid in the file name", async () => {
  const { dir, socket } = setup({ name: null });
  await socket.start();
  assert.equal(socket.path, path.join(dir, `pid-${process.pid}.sock`));
  socket.close();
});

test("start does not touch a non-socket file with the same name", async () => {
  const { dir, socket, warnings } = setup();
  const file = path.join(dir, "pm.sock");
  fs.writeFileSync(file, "keep");
  await socket.start();
  assert.equal(socket.path, null);
  assert.match(warnings[0], /not a socket owned by the current user/);
  assert.equal(fs.readFileSync(file, "utf8"), "keep");
});

test("start does not follow a symbolic link with the same name", async () => {
  const { dir, socket, warnings } = setup();
  const target = path.join(dir, "target");
  fs.writeFileSync(target, "keep");
  fs.symlinkSync(target, path.join(dir, "pm.sock"));
  await socket.start();
  assert.equal(socket.path, null);
  assert.equal(warnings.length, 1);
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
});

test("start warns and creates no socket in a directory open to others", async () => {
  const dir = tmpDir();
  fs.chmodSync(dir, 0o755);
  const { socket, warnings } = setup({}, dir);
  await socket.start();
  assert.equal(socket.path, null);
  assert.match(warnings[0], /accessible by others/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("start warns when the run directory is too long for a socket path", async () => {
  const { socket, warnings } = setup({ runDir: path.join(tmpDir(), "d".repeat(100)) });
  await socket.start();
  assert.equal(socket.path, null);
  assert.match(warnings[0], /too long/);
});

test("start removes stale sockets of the run directory in the background", async () => {
  const dir = tmpDir();
  const stale = path.join(dir, "old.sock");
  fs.chmodSync(dir, 0o700);
  await leaveStale(stale);
  const past = new Date(Date.now() - 10_000);
  fs.utimesSync(stale, past, past);
  const { socket } = setup({}, dir);
  await socket.start();
  for (let i = 0; i < 30 && fs.existsSync(stale); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.existsSync(stale), false);
  assert.ok(fs.existsSync(path.join(dir, "pm.sock")));
  socket.close();
});

test("a stale socket with the same name is replaced", async () => {
  const dir = tmpDir();
  const stale = path.join(dir, "pm.sock");
  fs.chmodSync(dir, 0o700);
  await leaveStale(stale);
  const past = new Date(Date.now() - 10_000);
  fs.utimesSync(stale, past, past);
  const { socket, warnings } = setup({}, dir);
  await socket.start();
  assert.deepEqual(warnings, []);
  assert.equal(socket.path, stale);
  assert.equal((await exchange(stale, line({ type: "info" })))?.ok, true);
  socket.close();
});

test("a write failure before the paste is not retryable and reports internal", async () => {
  const { dir, host, socket } = setup();
  host.throwOnWrite = 1;
  await socket.start();
  const res = await exchange(path.join(dir, "pm.sock"), line({ type: "send", text: "hello" }));
  assert.deepEqual(res, { ok: false, error: "not_ready", reason: "internal", retryable: false });
  assert.deepEqual(host.events, ["pasteStarted", "aborted"]);
  socket.close();
});

test("a write failure after the paste reports pasted and is not retryable", async () => {
  const { dir, host, socket, logs } = setup();
  host.throwOnWrite = 2;
  await socket.start();
  const res = await exchange(path.join(dir, "pm.sock"), line({ type: "send", text: "hello" }));
  assert.deepEqual(res, { ok: false, error: "not_ready", reason: "pasted", retryable: false, pasted: true });
  assert.deepEqual(host.events, ["pasteStarted", "leftover"]);
  assert.ok(logs.some(l => l.includes("after paste")));
  socket.close();
});

test("the check runs when a send is taken from the queue, not when it arrives", async () => {
  const { dir, host, socket } = setup({ recheckDelayMs: 100 });
  await socket.start();
  const file = path.join(dir, "pm.sock");
  const first = exchange(file, line({ type: "send", text: "one" }));
  await new Promise(r => setTimeout(r, 20));
  const second = exchange(file, line({ type: "send", text: "two" }));
  await new Promise(r => setTimeout(r, 20));
  host.failBefore = { error: "user_typing", reason: "user_typing" };
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: false, error: "user_typing", reason: "user_typing", retryable: true });
  assert.deepEqual(host.writes, ["\x1b[200~one\x1b[201~", "\r"]);
  socket.close();
});

test("a long name falls back to a different file name when the first is taken", async () => {
  const dir = tmpDir();
  const name = "n".repeat(120);
  const a = setup({ name }, dir);
  const b = setup({ name }, dir);
  await a.socket.start();
  await b.socket.start();
  assert.ok(a.socket.path && b.socket.path);
  assert.notEqual(a.socket.path, b.socket.path);
  b.socket.close();
  a.socket.close();
});

test("connections past twice the limit are dropped without a response", async () => {
  const { dir, socket } = setup({ maxConnections: 1 });
  await socket.start();
  const file = path.join(dir, "pm.sock");
  const idle = [net.connect(file), net.connect(file), net.connect(file)];
  idle.forEach(c => c.on("error", () => {}));
  await new Promise(r => setTimeout(r, 100));
  const res = await exchange(file, line({ type: "info" }));
  assert.equal(res, null);
  idle.forEach(c => c.destroy());
  socket.close();
});

test("close removes the socket file synchronously and drops open connections", async () => {
  const { dir, socket } = setup();
  await socket.start();
  const file = path.join(dir, "pm.sock");
  const client = net.connect(file);
  const closed = new Promise<void>(resolve => client.on("close", () => resolve()));
  client.on("error", () => {});
  await new Promise(r => setTimeout(r, 30));
  socket.close();
  assert.equal(fs.existsSync(file), false);
  await closed;
});

test("sends after a failed send are still processed", async () => {
  const { dir, host, socket } = setup();
  host.throwOnWrite = 2;
  await socket.start();
  const file = path.join(dir, "pm.sock");
  const first = await exchange(file, line({ type: "send", text: "one" }));
  assert.equal(first?.reason, "pasted");
  host.throwOnWrite = null;
  const second = await exchange(file, line({ type: "send", text: "two" }));
  assert.deepEqual(second, { ok: true });
  assert.deepEqual(host.writes.slice(-2), ["\x1b[200~two\x1b[201~", "\r"]);
  socket.close();
});

test("a client that shuts down its write side after the request still gets the response", async () => {
  const { dir, host, socket } = setup();
  await socket.start();
  const res = await exchange(path.join(dir, "pm.sock"), line({ type: "send", text: "hi" }), { end: true });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(host.writes, ["\x1b[200~hi\x1b[201~", "\r"]);
  socket.close();
});

test("a half-closed send queued behind another is still processed", async () => {
  const { dir, host, socket } = setup({ recheckDelayMs: 60 });
  await socket.start();
  const file = path.join(dir, "pm.sock");
  const first = exchange(file, line({ type: "send", text: "one" }));
  await new Promise(r => setTimeout(r, 15));
  const second = exchange(file, line({ type: "send", text: "two" }), { end: true });
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  assert.equal(host.writes.length, 4);
  socket.close();
});
