// The lock that keeps one process at a time reading Hugging Face: the daemon and `walkie pool` share <home>/pool.
//
// The lock is a small file made COMPLETE first and then linked into place (link(2) fails if the path exists), so it is
// never seen half-written and two creators cannot both win. It holds the owner's pid and a random token. A lock whose
// process is gone, or older than a refresh can last, is a crashed refresh's and is taken over, but only under a second,
// short-lived "takeover" file, and only after judging it stale AGAIN under that file: two processes that both thought it
// stale cannot then delete and re-create it one after the other (the second would remove the first's fresh lock). A
// release removes the lock only while it still holds the owner's token. A lock whose mtime is in the future (a clock that
// was set back) gets its window restarted from now instead of staying busy for as long as the clock was off. Anything at
// the lock path that is not a plain file (a folder, a link) cannot be a lock: that is reported, and the read goes ahead
// without one rather than waiting for ever. docs/plans/LOCAL-MODELS-HF-1.md "Source".
import { linkSync, lstatSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** A whole refresh must be over in this long (source.ts REFRESH_DEADLINE_MS). */
const REFRESH_DEADLINE_MS = 120_000;
/** A lock this old, or whose process is gone, is a crashed refresh's and is taken over. */
export const LOCK_STALE_MS = REFRESH_DEADLINE_MS + 30_000;
/** A takeover in progress takes milliseconds; one this old was left by a crash. */
export const TAKEOVER_STALE_MS = 30_000;
/** Clock slack: an mtime this far ahead of now is "in the future". */
const FUTURE_SLACK_MS = 2_000;

export const lockPath = (home: string): string => join(home, "pool", "hf-refresh.lock");
export const takeoverPath = (home: string): string => `${lockPath(home)}.takeover`;

export type Release = () => void;
const NO_LOCK: Release = () => undefined;

export interface LockHooks {
  /** Tests: runs after this process judged the lock stale and before it tries to take it over (an interleaving point). */
  afterJudgedStale?: () => void;
  /** Reports a lock path that cannot be used (a folder, a link): the read goes ahead without a lock. */
  report?: (reason: string) => void;
}

const pidAlive = (pid: unknown): boolean => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true; // unknown: trust the age only
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
};

const holderOf = (path: string): { pid?: unknown; token?: unknown } => {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as { pid?: unknown; token?: unknown }) : {};
  } catch { return {}; } // empty, half-written by something else, not JSON
};

/** Creates `path` with its full content or not at all; false when it already exists. */
function createExclusive(path: string, token: string): boolean {
  const tmp = `${path}.${token}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: "wx" });
    try { linkSync(tmp, path); return true; } catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; throw err; }
  } finally { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } }
}

/** Removes `path` only while it still holds `token`. */
function removeIfOurs(path: string, token: string): void {
  try { if (holderOf(path).token === token) rmSync(path, { force: true }); } catch { /* best effort */ }
}

type Verdict = "free" | "busy" | "stale" | "unusable";

/** What the file at `path` is: absent, a live lock, a dead one, or not a lock at all. */
function judge(path: string, stale: number): Verdict {
  let st;
  try { st = lstatSync(path); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "unusable"; }
  if (!st.isFile()) return "unusable";
  const now = Date.now();
  if (!pidAlive(holderOf(path).pid)) return "stale"; // its owner is gone: its date does not matter
  if (st.mtimeMs > now + FUTURE_SLACK_MS) {
    // Dated in the future: its age cannot be told. Restart the window from now, so it is stale after the usual time.
    try { utimesSync(path, new Date(now), new Date(now)); } catch { /* cannot be touched: its owner is alive, so it is busy */ }
    return "busy";
  }
  return now - st.mtimeMs > stale ? "stale" : "busy";
}

/**
 * Takes the refresh lock: a release function, "busy" when a live refresh holds it, or a no-op release when no lock is
 * possible (the folder cannot be written, or the lock path is not a plain file): an unwritable home must not stop the list
 * from being read.
 */
export function takeLock(home: string, hooks: LockHooks = {}): Release | "busy" {
  const path = lockPath(home);
  const takeover = takeoverPath(home);
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch { return NO_LOCK; }
  const release: Release = () => removeIfOurs(path, token);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (createExclusive(path, token)) return release;
      const verdict = judge(path, LOCK_STALE_MS);
      if (verdict === "unusable") { hooks.report?.("the refresh lock path is not a plain file"); return NO_LOCK; }
      if (verdict === "free") continue;
      if (verdict === "busy") return "busy";
      hooks.afterJudgedStale?.();
      // Stale: take it over under the takeover file, judging it again once nobody else can be doing the same.
      if (!createExclusive(takeover, token)) {
        const t = judge(takeover, TAKEOVER_STALE_MS);
        if (t === "unusable") { hooks.report?.("the refresh lock's takeover path is not a plain file"); return NO_LOCK; }
        if (t === "stale") { try { rmSync(takeover, { force: true }); } catch { /* raced */ } continue; }
        return "busy"; // someone else is taking it over right now
      }
      try {
        if (judge(path, LOCK_STALE_MS) === "stale") rmSync(path, { force: true });
      } finally { removeIfOurs(takeover, token); }
    }
  } catch (err) {
    hooks.report?.(`no refresh lock could be made (${(err as Error).message.slice(0, 100)})`);
    return NO_LOCK;
  }
  return "busy";
}
