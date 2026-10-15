import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Give every fixture ancestor a fixed mode, independent of the runner's umask. */
export function privateFixtureDir(root: string, path: string): void {
  mkdirSync(path, { recursive: true });
  for (let dir = path; dir !== root; dir = dirname(dir)) {
    if (!dir.startsWith(`${root}/`)) throw new Error(`fixture path is outside its root: ${path}`);
    chmodSync(dir, 0o755);
  }
}
