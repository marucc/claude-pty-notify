import crypto from "node:crypto";
import path from "node:path";

// sockaddr_un.sun_path is 104 bytes on macOS; keep some margin
export const MAX_SOCKET_PATH_BYTES = 100;

// File name stem for a session name; pid-based when there is no usable name
export function socketStem(name: string | null, pid: number): string {
  if (name !== null) {
    const replaced = name.replace(/[^\p{L}\p{N}\-_.]/gu, "_");
    if (replaced !== "" && replaced !== "." && replaced !== "..") return replaced.replace(/^\./, "_");
  }
  return `pid-${pid}`;
}

function truncateUtf8(text: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

// "<stem>.sock" that keeps the full path within MAX_SOCKET_PATH_BYTES, or null when even a truncated name does not fit
// A truncated stem gets "-" and the first 8 hex digits of sha256(hashSource) so different sessions stay distinct
export function socketFileName(runDir: string, stem: string, hashSource: string): string | null {
  const overhead = Buffer.byteLength(path.join(runDir, ".sock"));
  if (overhead + Buffer.byteLength(stem) <= MAX_SOCKET_PATH_BYTES) return `${stem}.sock`;
  const budget = MAX_SOCKET_PATH_BYTES - overhead - 9;
  if (budget < 0) return null;
  const hash = crypto.createHash("sha256").update(hashSource).digest("hex").slice(0, 8);
  return `${truncateUtf8(stem, budget)}-${hash}.sock`;
}
