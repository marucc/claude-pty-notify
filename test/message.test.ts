import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LOCALES_DIR, languageCandidates, resolveMessages, formatMessage, unreadMarker, permissionMarker } from "../src/message.ts";

test("languageCandidates strips encoding and falls back to the base language and en", () => {
  assert.deepEqual(languageCandidates({ LANG: "pt_BR.UTF-8" }), ["pt_BR", "pt", "en"]);
});

test("languageCandidates returns en only for the C and POSIX locales", () => {
  assert.deepEqual(languageCandidates({ LANG: "C" }), ["en"]);
  assert.deepEqual(languageCandidates({ LANG: "POSIX" }), ["en"]);
});

test("languageCandidates returns en only when no locale is set", () => {
  assert.deepEqual(languageCandidates({}), ["en"]);
});

test("languageCandidates ignores values that are not language tags", () => {
  assert.deepEqual(languageCandidates({ LANG: "../../etc/passwd" }), ["en"]);
});

test("languageCandidates prefers LC_ALL over LC_MESSAGES over LANG", () => {
  assert.equal(languageCandidates({ LC_ALL: "fr_FR.UTF-8", LC_MESSAGES: "ja_JP.UTF-8", LANG: "de_DE.UTF-8" })[0], "fr_FR");
  assert.equal(languageCandidates({ LC_MESSAGES: "ja_JP.UTF-8", LANG: "de_DE.UTF-8" })[0], "ja_JP");
});

test("languageCandidates treats an empty LC_ALL as unset", () => {
  assert.equal(languageCandidates({ LC_ALL: "", LANG: "ja_JP.UTF-8" })[0], "ja_JP");
});

test("languageCandidates strips the modifier", () => {
  assert.deepEqual(languageCandidates({ LANG: "sr_RS@latin" }), ["sr_RS", "sr", "en"]);
});

test("languageCandidates accepts a bare language", () => {
  assert.deepEqual(languageCandidates({ LANG: "ja" }), ["ja", "en"]);
});

test("languageCandidates returns en only for C.UTF-8 and script subtags", () => {
  assert.deepEqual(languageCandidates({ LANG: "C.UTF-8" }), ["en"]);
  assert.deepEqual(languageCandidates({ LANG: "zh_Hant_TW.UTF-8" }), ["en"]);
});

test("resolveMessages returns Japanese templates when LANG is ja", () => {
  assert.deepEqual(resolveMessages({ LANG: "ja_JP.UTF-8" }), {
    waiting: "{session} 入力待ち",
    permission: "{session} 許可待ち",
    question: "{session} 回答待ち",
  });
});

test("resolveMessages returns English templates when LANG is en", () => {
  assert.deepEqual(resolveMessages({ LANG: "en_US.UTF-8" }), {
    waiting: "{session} is waiting for input",
    permission: "{session} needs permission",
    question: "{session} is waiting for an answer",
  });
});

test("resolveMessages falls back to English for an unsupported language", () => {
  assert.equal(resolveMessages({ LANG: "xx_YY.UTF-8" }).waiting, "{session} is waiting for input");
});

test("formatMessage replaces {session} with the session name", () => {
  assert.equal(formatMessage("{session} 入力待ち", "demo"), "demo 入力待ち");
});

test("formatMessage keeps $ patterns in the session name literal", () => {
  assert.equal(formatMessage("{session} is waiting for input", "cost $& $' $$"), "cost $& $' $$ is waiting for input");
});

test("every locale file has the same keys as en.json", () => {
  const read = (file: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), "utf8"));
  const expected = Object.keys(read("en.json")).sort();
  for (const file of fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith(".json"))) {
    assert.deepEqual(Object.keys(read(file)).sort(), expected, file);
  }
});

test("every locale message contains the {session} placeholder", () => {
  for (const file of fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith(".json"))) {
    const messages: Record<string, string> = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), "utf8"));
    for (const [key, text] of Object.entries(messages)) {
      assert.ok(text.includes("{session}"), `${file}: ${key}`);
    }
  }
});

test("unreadMarker returns the four-pointed star by default", () => {
  assert.equal(unreadMarker({}), "✦");
});

test("unreadMarker returns CLAUDE_PTY_UNREAD_MARKER when set", () => {
  assert.equal(unreadMarker({ CLAUDE_PTY_UNREAD_MARKER: "\u{F009A}" }), "\u{F009A}");
});

test("permissionMarker returns the play symbol by default", () => {
  assert.equal(permissionMarker({}), "▶");
});

test("permissionMarker returns CLAUDE_PTY_PERMISSION_MARKER when set", () => {
  assert.equal(permissionMarker({ CLAUDE_PTY_PERMISSION_MARKER: "?" }), "?");
});
