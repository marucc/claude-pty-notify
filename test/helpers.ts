import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cpn-"));
}

// A socket file with nobody listening: a process binds it and is killed before it can clean up
export async function leaveStale(file: string): Promise<void> {
  const script = `require("net").createServer().listen(process.argv[1], () => console.log("ready"))`;
  const child = spawn(process.execPath, ["-e", script, file], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>(resolve => child.stdout.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise(resolve => child.once("exit", resolve));
}
