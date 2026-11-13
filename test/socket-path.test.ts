import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { MAX_SOCKET_PATH_BYTES, socketFileName, socketStem } from "../src/socket-path.ts";

test("socketStem keeps letters, digits and - _ .", () => {
  assert.equal(socketStem("pm-1_a.b", 1), "pm-1_a.b");
  assert.equal(socketStem("日本語1", 1), "日本語1");
});

test("socketStem replaces other characters and a leading dot with _", () => {
  assert.equal(socketStem("a/b c:d", 1), "a_b_c_d");
  assert.equal(socketStem(".hidden", 1), "_hidden");
  assert.equal(socketStem("../x", 1), "_._x");
});

test("socketStem uses the pid without a usable name", () => {
  assert.equal(socketStem(null, 42), "pid-42");
  assert.equal(socketStem("", 42), "pid-42");
  assert.equal(socketStem(".", 42), "pid-42");
  assert.equal(socketStem("..", 42), "pid-42");
});

test("socketFileName appends .sock when the path fits", () => {
  assert.equal(socketFileName("/run", "foo", "foo"), "foo.sock");
});

test("socketFileName truncates with a hash of the source to fit 100 bytes", () => {
  const dir = "/tmp/run";
  const stem = "x".repeat(200);
  const file = socketFileName(dir, stem, "source")!;
  const hash = crypto.createHash("sha256").update("source").digest("hex").slice(0, 8);
  assert.ok(file.endsWith(`-${hash}.sock`));
  assert.equal(Buffer.byteLength(path.join(dir, file)), MAX_SOCKET_PATH_BYTES);
});

test("socketFileName cuts on a UTF-8 character boundary", () => {
  const dir = "/tmp/run";
  const file = socketFileName(dir, "あ".repeat(100), "s")!;
  assert.ok(Buffer.byteLength(path.join(dir, file)) <= MAX_SOCKET_PATH_BYTES);
  assert.ok(!file.includes("�"));
  assert.match(file, /^あ+-[0-9a-f]{8}\.sock$/);
});

test("socketFileName gives different names to different long sources", () => {
  const stem = "y".repeat(200);
  assert.notEqual(socketFileName("/r", stem, "a"), socketFileName("/r", stem, "b"));
});

test("socketFileName returns null when the directory is too long", () => {
  assert.equal(socketFileName(`/${"d".repeat(95)}`, "foo", "foo"), null);
});
