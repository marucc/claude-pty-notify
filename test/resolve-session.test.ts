import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SRC = path.resolve(import.meta.dirname, "../src");
const SHIM = path.resolve(import.meta.dirname, "../shim.sh");
const OLD_ID = "11111111-1111-1111-1111-111111111111";
const NEW_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";

// projects/<project>/<id>.jsonl を作る。mtime は秒で指定する（大きいほど新しい）
function setup(): { home: string; projects: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-session-"));
  const projects = path.join(home, "projects");
  fs.mkdirSync(path.join(projects, "p1"), { recursive: true });
  fs.mkdirSync(path.join(projects, "p2"), { recursive: true });
  const write = (project: string, id: string, title: string, mtime: number) => {
    const file = path.join(projects, project, `${id}.jsonl`);
    fs.writeFileSync(file, `{"type":"custom-title","customTitle":"${title}","sessionId":"${id}"}\n`);
    fs.utimesSync(file, mtime, mtime);
  };
  write("p1", OLD_ID, "worker: 969-pr4-reset", 1000);
  write("p2", NEW_ID, "worker: 969-pr4-reset", 2000);
  write("p1", OTHER_ID, "worker: 969-pr4-reset-extra", 3000);
  // 本物の claude の代わりに、受け取った引数を1行ずつ出力するスタブ
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  const stub = path.join(home, ".local/bin/claude");
  fs.writeFileSync(stub, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 });
  return { home, projects };
}

function resolve(name: string, projects: string) {
  return spawnSync(path.join(SRC, "resolve-session.sh"), [name], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECTS_DIR: projects },
  });
}

function shim(args: string[], home: string, projects: string) {
  const r = spawnSync(SHIM, args, {
    encoding: "utf8",
    env: { ...process.env, HOME: home, CLAUDE_PROJECTS_DIR: projects, CLAUDE_PTY_WRAPPED: "1" },
  });
  return r.stdout.split("\n").filter(Boolean);
}

test("resolve-session returns the newest transcript for an exact title match", () => {
  const { projects } = setup();
  const r = resolve("worker: 969-pr4-reset", projects);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), NEW_ID);
});

test("resolve-session ignores a title that appears after the first 16KB of a transcript", () => {
  const { projects } = setup();
  const late = path.join(projects, "p1", "44444444-4444-4444-4444-444444444444.jsonl");
  fs.writeFileSync(late, `${"x".repeat(20000)}\n{"type":"custom-title","customTitle":"late-title"}\n`);
  assert.equal(resolve("late-title", projects).status, 1);
});

test("resolve-session does not match a longer title that merely starts with the name", () => {
  const { projects } = setup();
  const r = resolve("worker: 969-pr4", projects);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
});

test("resolve-session exits 1 without output when the name is a UUID or empty or unknown", () => {
  const { projects } = setup();
  for (const name of [OLD_ID, "", "no-such-session"]) {
    const r = resolve(name, projects);
    assert.equal(r.status, 1, name);
    assert.equal(r.stdout, "", name);
  }
});

test("shim replaces the name after -r and --resume with the session ID", () => {
  const { home, projects } = setup();
  assert.deepEqual(shim(["--agent", "worker", "-r", "worker: 969-pr4-reset"], home, projects), ["--agent", "worker", "-r", NEW_ID]);
  assert.deepEqual(shim(["--resume", "worker: 969-pr4-reset"], home, projects), ["--resume", NEW_ID]);
});

test("shim replaces the name in --resume=<name>", () => {
  const { home, projects } = setup();
  assert.deepEqual(shim(["--resume=worker: 969-pr4-reset"], home, projects), [`--resume=${NEW_ID}`]);
});

test("shim passes a UUID, an unknown name, and a bare -r through unchanged", () => {
  const { home, projects } = setup();
  assert.deepEqual(shim(["-r", OLD_ID], home, projects), ["-r", OLD_ID]);
  assert.deepEqual(shim(["-r", "no-such-session"], home, projects), ["-r", "no-such-session"]);
  assert.deepEqual(shim(["-r"], home, projects), ["-r"]);
  assert.deepEqual(shim(["-r", "--model", "sonnet"], home, projects), ["-r", "--model", "sonnet"]);
});

test("shim leaves arguments without -r untouched", () => {
  const { home, projects } = setup();
  assert.deepEqual(shim(["-p", "worker: 969-pr4-reset"], home, projects), ["-p", "worker: 969-pr4-reset"]);
});
