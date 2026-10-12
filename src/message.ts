import fs from "node:fs";
import path from "node:path";

export type MessageKey = "waiting" | "permission" | "question";
export type Messages = Record<MessageKey, string>;

const MESSAGE_KEYS: MessageKey[] = ["waiting", "permission", "question"];

export const LOCALES_DIR = path.join(import.meta.dirname, "..", "locales");
const DEFAULT_LANGUAGE = "en";
// Only plain language tags (ja, pt_BR) are looked up, so env values cannot point outside LOCALES_DIR
const LANGUAGE_RE = /^[A-Za-z]{2,3}(?:_[A-Za-z]{2})?$/;

// Languages to try in order, e.g. pt_BR.UTF-8 → ["pt_BR", "pt", "en"]
// Locale precedence follows POSIX: LC_ALL > LC_MESSAGES > LANG
export function languageCandidates(env: NodeJS.ProcessEnv): string[] {
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  const name = locale.split(/[.@]/)[0];
  if (!LANGUAGE_RE.test(name)) return [DEFAULT_LANGUAGE];
  return [...new Set([name, name.split("_")[0], DEFAULT_LANGUAGE])];
}

function loadLocale(language: string): Partial<Messages> | null {
  const file = path.join(LOCALES_DIR, `${language}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

// Message templates in the user's language, resolved once at startup
// so a broken locale file fails before the session starts instead of in the middle of it
export function resolveMessages(env: NodeJS.ProcessEnv): Messages {
  const locales = languageCandidates(env).map(loadLocale);
  const entries = MESSAGE_KEYS.map(key => {
    const template = locales.find(locale => locale?.[key])?.[key];
    if (!template) throw new Error(`Missing message "${key}" in ${DEFAULT_LANGUAGE}.json`);
    return [key, template];
  });
  return Object.fromEntries(entries);
}

export function formatMessage(template: string, sessionName: string): string {
  // A replacer function keeps "$&" etc. in session names literal
  return template.replaceAll("{session}", () => sessionName);
}

// Overridable with CLAUDE_PTY_UNREAD_MARKER
export function unreadMarker(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_PTY_UNREAD_MARKER || "✦";
}

// Overridable with CLAUDE_PTY_PERMISSION_MARKER
export function permissionMarker(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_PTY_PERMISSION_MARKER || "▶";
}
