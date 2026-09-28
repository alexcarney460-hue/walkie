// COMPANY POOL: the CODEX_HOME a borrowing machine runs a leased Codex login in. It lives under the vault's Codex root
// (`lease-<grant>`, 0700), holds the access-only auth.json the home machine sealed to this machine (0600; never a
// refresh token — checked again here) and the usual links to the person's own CODEX_HOME (sessions, history, a cleaned
// config copy: syncCodexHome). It is deleted when the session ends; one whose process is gone is swept on the next use.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isAccessOnly } from "./codex-access.ts";
import { syncCodexHome, vaultCodexRoot } from "./codex-home.ts";
import { privateDir } from "./vault.ts";

const LEASE_DIR_RE = /^lease-[0-9a-f]{16}$/;
const OWNER_FILE = ".walkie-lease";

/** Whether `dir` is one of this vault's leased Codex homes (never anything else is deleted as one). */
export function isLeaseHome(dir: string, walkieHome: string): boolean {
  return resolve(dirname(dir)) === resolve(vaultCodexRoot(walkieHome)) && LEASE_DIR_RE.test(basename(dir));
}

/**
 * Makes the leased home for one session: `grant` names it (16 hex, from the owner's reply), `authJson` must be an
 * access-only copy. The directory must not exist yet (a grant is used once).
 */
export function writeLeaseHome(walkieHome: string, baseHome: string, grant: string, authJson: string, pid = process.pid): string {
  if (!/^[0-9a-f]{16}$/.test(grant)) throw new Error("invalid lease grant");
  if (!isAccessOnly(authJson)) throw new Error("refusing a Codex login that is not access-only");
  const root = vaultCodexRoot(walkieHome);
  privateDir(join(walkieHome, "vault"), true);
  privateDir(root, true);
  const dir = join(root, `lease-${grant}`);
  mkdirSync(dir, { mode: 0o700 }); // throws when it exists: a grant backs one home
  try {
    // The session's pid AND its start time: a pid reused by another process never keeps a stale home alive.
    writeFileSync(join(dir, OWNER_FILE), `${pid} ${processStart(pid) ?? ""}`.trim(), { mode: 0o600, flag: "wx" });
    writeFileSync(join(dir, "auth.json"), authJson, { mode: 0o600, flag: "wx" });
    syncCodexHome(dir, baseHome);
    return dir;
  } catch (err) {
    removeLeaseHome(dir, walkieHome);
    throw err;
  }
}

/**
 * Deletes a leased home: symlinks are unlinked (never followed), everything else in it (the access-only auth.json,
 * Walkie's config copies, files Codex made there) is removed. Refuses anything that is not a lease home.
 */
export function removeLeaseHome(dir: string, walkieHome: string): void {
  if (!isLeaseHome(dir, walkieHome)) throw new Error("refusing to delete a directory that is not a leased Codex home");
  if (!existsSync(dir)) return;
  if (lstatSync(dir).isSymbolicLink()) { unlinkSync(dir); return; }
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (lstatSync(p).isSymbolicLink()) unlinkSync(p);
    else rmSync(p, { recursive: true, force: true }); // rm never follows links inside a directory
  }
  rmdirSync(dir);
}

/** A process's start time as `ps` prints it (stable for its life), or null when it cannot be read. */
export function processStart(pid: number): string | null {
  try {
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const t = r.exitCode === 0 ? r.stdout.toString().trim() : "";
    return t && t.length <= 64 ? t : null;
  } catch {
    return null;
  }
}

/** The recorded session still runs: its pid exists and (when recorded) started at the recorded time. */
function alive(pid: number, start: string | null): boolean {
  try { process.kill(pid, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EPERM") return false; }
  if (!start) return true;
  return processStart(pid) === start;
}

/** Removes leased homes whose session process is gone (a crash, a kill -9). Returns how many. */
export function sweepLeaseHomes(walkieHome: string): number {
  const root = vaultCodexRoot(walkieHome);
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const name of readdirSync(root)) {
    if (!LEASE_DIR_RE.test(name)) continue;
    const dir = join(root, name);
    let pid = NaN;
    let start: string | null = null;
    try {
      const [p, ...rest] = readFileSync(join(dir, OWNER_FILE), "utf8").trim().split(" ");
      pid = Number(p);
      start = rest.join(" ") || null;
    } catch { /* unreadable: stale */ }
    if (Number.isInteger(pid) && pid > 0 && alive(pid, start)) continue;
    try { removeLeaseHome(dir, walkieHome); n++; } catch { /* left for the next sweep */ }
  }
  return n;
}
