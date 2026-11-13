import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { checkRunDir, cleanStaleSockets, isSocketDead, reapIfStale } from "../src/socket-files.ts";
import { leaveStale, tmpDir } from "./helpers.ts";

function listen(file: string): Promise<net.Server> {
  return new Promise(resolve => {
    const server = net.createServer(s => s.destroy());
    server.listen(file, () => resolve(server));
  });
}

test("checkRunDir creates a missing directory with mode 0700", () => {
  const dir = path.join(tmpDir(), "run");
  assert.equal(checkRunDir(dir), null);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test("checkRunDir rejects a directory open to others", () => {
  const dir = tmpDir();
  fs.chmodSync(dir, 0o755);
  assert.match(checkRunDir(dir)!, /accessible by others/);
});

test("checkRunDir rejects a symbolic link", () => {
  const base = tmpDir();
  const real = path.join(base, "real");
  fs.mkdirSync(real, { mode: 0o700 });
  const link = path.join(base, "link");
  fs.symlinkSync(real, link);
  assert.match(checkRunDir(link)!, /not a directory/);
});

test("checkRunDir rejects a regular file", () => {
  const file = path.join(tmpDir(), "f");
  fs.writeFileSync(file, "");
  assert.ok(checkRunDir(file));
});

test("isSocketDead is false while a server listens", async () => {
  const file = path.join(tmpDir(), "a.sock");
  const server = await listen(file);
  assert.equal(await isSocketDead(file), false);
  server.close();
});

test("isSocketDead is true when nobody listens", async () => {
  const file = path.join(tmpDir(), "a.sock");
  await leaveStale(file);
  assert.equal(await isSocketDead(file), true);
});

test("isSocketDead is true when the file is gone", async () => {
  assert.equal(await isSocketDead(path.join(tmpDir(), "none.sock")), true);
});

test("reapIfStale keeps a live socket", async () => {
  const file = path.join(tmpDir(), "a.sock");
  const server = await listen(file);
  assert.equal(await reapIfStale(file), "alive");
  assert.ok(fs.existsSync(file));
  server.close();
});

test("reapIfStale keeps a fresh dead socket and removes an old one", async () => {
  const file = path.join(tmpDir(), "a.sock");
  await leaveStale(file);
  assert.equal(await reapIfStale(file), "alive");
  assert.equal(await reapIfStale(file, () => Date.now() + 3000), "removed");
  assert.equal(fs.existsSync(file), false);
});

test("reapIfStale does not remove a socket replaced during the check", async () => {
  const file = path.join(tmpDir(), "a.sock");
  await leaveStale(file);
  let calls = 0;
  const now = () => {
    // After the connection probes, another wrapper takes the name before the final lstat
    if (++calls === 1) {
      fs.unlinkSync(file);
      fs.writeFileSync(file, "");
    }
    return Date.now() + 3000;
  };
  const result = await reapIfStale(file, now);
  assert.notEqual(result, "removed");
  assert.ok(fs.existsSync(file));
});

test("reapIfStale leaves regular files and symbolic links alone", async () => {
  const dir = tmpDir();
  const regular = path.join(dir, "r.sock");
  fs.writeFileSync(regular, "");
  assert.equal(await reapIfStale(regular), "foreign");
  const link = path.join(dir, "l.sock");
  fs.symlinkSync(regular, link);
  assert.equal(await reapIfStale(link), "foreign");
  assert.equal(await reapIfStale(path.join(dir, "none.sock")), "gone");
  assert.ok(fs.existsSync(regular) && fs.existsSync(link));
});

test("cleanStaleSockets removes only stale own sockets and skips the given one", async () => {
  const dir = tmpDir();
  const live = path.join(dir, "live.sock");
  const server = await listen(live);
  const regular = path.join(dir, "file.sock");
  fs.writeFileSync(regular, "");
  const other = path.join(dir, "note.txt");
  fs.writeFileSync(other, "");
  const removed = await cleanStaleSockets(dir, live);
  assert.deepEqual(removed, []);
  assert.ok(fs.existsSync(live) && fs.existsSync(regular) && fs.existsSync(other));
  server.close();
});
