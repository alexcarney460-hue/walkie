// A durable local marker for Codex session folders Walkie has shared with a vault home. Rollout files do not name the
// login that produced them, so removing the vault link cannot make old files safe for the base login to read.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { join } from "node:path";

function marker(root: string, sessions: string): string {
  const id = createHash("sha256").update(sessions).digest("hex");
  return join(root, `.shared-sessions-${id}`);
}

function inodeMarker(root: string, sessions: string): string {
  const { dev, ino } = statSync(sessions, { bigint: true });
  const id = createHash("sha256").update(`${dev}:${ino}`).digest("hex");
  return join(root, `.shared-sessions-inode-${id}`);
}

function ensureMarker(path: string, warn: (message: string) => void): void {
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (!lstatSync(path).isFile()) warn("Codex shared-sessions marker path is not a regular file; passive readings remain fenced");
  }
}

export function recordSharedCodexSessions(root: string, sessions: string, warn: (message: string) => void = console.warn): void {
  ensureMarker(marker(root, sessions), warn);
  try { ensureMarker(inodeMarker(root, sessions), warn); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}

/** An occupied marker path means shared; other inspection errors withhold only this poll. */
export function wasCodexSessionsShared(root: string, sessions: string): "shared" | "unshared" | "unknown" {
  let uncertain = false;
  try { lstatSync(marker(root, sessions)); return "shared"; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") uncertain = true; }
  let byInode: string;
  try { byInode = inodeMarker(root, sessions); } catch { return "unknown"; }
  try { lstatSync(byInode); return "shared"; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") uncertain = true; }
  return uncertain ? "unknown" : "unshared";
}
