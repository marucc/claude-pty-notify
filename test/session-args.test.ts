import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrintMode, parseSessionArgs } from "../src/session-args.ts";

const ID = "123e4567-e89b-12d3-a456-426614174000";
const ID2 = "223e4567-e89b-12d3-a456-426614174000";

test("parseSessionArgs reads the name from -n, --name and --name=", () => {
  assert.equal(parseSessionArgs(["-n", "foo"]).name, "foo");
  assert.equal(parseSessionArgs(["--name", "foo"]).name, "foo");
  assert.equal(parseSessionArgs(["--name=foo"]).name, "foo");
});

test("parseSessionArgs strips a trailing hash suffix once", () => {
  assert.equal(parseSessionArgs(["-n", "foo [ab12]"]).name, "foo");
  assert.equal(parseSessionArgs(["-n", "foo [x] [ab12]"]).name, "foo [x]");
  assert.equal(parseSessionArgs(["-n", "foo[ab12]"]).name, "foo[ab12]");
});

test("parseSessionArgs ignores -n=<name>", () => {
  assert.equal(parseSessionArgs(["-n=foo"]).name, null);
});

test("parseSessionArgs lets the last name win and does not fall back", () => {
  assert.equal(parseSessionArgs(["-n", "a", "--name", "b"]).name, "b");
  assert.equal(parseSessionArgs(["-n", "a", "--name"]).name, null);
  assert.equal(parseSessionArgs(["-n", "a", "--name="]).name, null);
  assert.equal(parseSessionArgs(["-n", "a", "-n", " [ab12]"]).name, null);
});

test("parseSessionArgs takes a value starting with a dash", () => {
  assert.equal(parseSessionArgs(["-n", "-x"]).name, "-x");
});

test("parseSessionArgs ignores arguments after --", () => {
  const r = parseSessionArgs(["-n", "a", "--", "-n", "b", "-r", ID]);
  assert.deepEqual(r, { name: "a", sessionId: null });
});

test("parseSessionArgs reads the last session id given as a UUID", () => {
  assert.equal(parseSessionArgs(["--resume", ID]).sessionId, ID);
  assert.equal(parseSessionArgs(["-r", ID, "--session-id", ID2]).sessionId, ID2);
  assert.equal(parseSessionArgs(["-r", "some name"]).sessionId, null);
  assert.equal(parseSessionArgs(["-r", ID, "-r", "name"]).sessionId, ID);
});

test("parseSessionArgs returns nulls without options", () => {
  assert.deepEqual(parseSessionArgs([]), { name: null, sessionId: null });
});

test("isPrintMode matches -p, --print and --print=value before --", () => {
  assert.equal(isPrintMode(["-p"]), true);
  assert.equal(isPrintMode(["--print"]), true);
  assert.equal(isPrintMode(["--print=x"]), true);
  assert.equal(isPrintMode(["-n", "-p"]), true);
});

test("isPrintMode ignores combined flags and arguments after --", () => {
  assert.equal(isPrintMode(["-pc"]), false);
  assert.equal(isPrintMode(["--", "-p"]), false);
  assert.equal(isPrintMode([]), false);
});
