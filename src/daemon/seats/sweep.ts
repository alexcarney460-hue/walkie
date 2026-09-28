// The seat user's own file sweep (SEATS-FIX-6; Codex r6 CRITICAL 1, HIGH 2; Opus r6 MEDIUM 2; SEATS-FIX-7: Opus r7
// 1-4): before its account is deleted, the seat user itself (the runner's `sweep` op, never root) removes every file
// it owns under the places a user can write outside its home, and empties its home. Running as that user is the
// containment: it can only remove what it may remove (sticky world-writable directories keep everyone else's
// entries), whatever a name or a swapped ancestor says.
//
// The walk is descriptor-relative (fsat.ts): each directory is opened by descriptor, entry by entry, never following a
// symlink and never crossing into another mount (a mount point met inside a root is reported); a directory entered is
// checked to be the one just inspected (a swap in between is noticed, never followed). Entries are removed one at a
// time, after the owner's own protections on them are cleared (its flags, its ACL); a directory only once empty
// (entries others own inside it keep it, and it is reported). Names are bytes, so a name with a newline is one name.
//
// Only where the seat could have created entries is walked (Opus r7 3): its own directories, and others' directories
// it may write to (by its effective ids, ACLs included). Others' directories it can't write are skipped, not
// descended. The entry and depth limits apply to its own subtrees (exceeding them there: not verified); others' depth
// is reported, never a reason to fail.
//
// Verification is the same walk again (repeated while it still finds something to remove, at most three passes): the
// last must remove nothing and find nothing of the user left, with no inspection problem. macOS may keep only empty
// SF_NOUNLINK directories inside its own per-user folder; those paths are recorded separately.
import { basename, dirname } from "node:path";
import {
  AT_FDCWD, FsatError, SF_NOUNLINK, canWriteAt, clearProtections, closeFd, fdIdentity, isDir, listDir, openDirAt, statAt, unlinkAt, type StatAt,
} from "./fsat.ts";

/** Whether an entry is the sweeping user's (its uid; tests add their fake ownership). */
export type OwnedFn = (st: StatAt, name: Uint8Array, parentOwned: boolean) => boolean;

export interface SweepRoot {
  path: string;
  /** Whether the root directory itself is the user's (its home, its per-user folder): kept, never removed. */
  owned?: boolean;
  /** macOS's own /private/var/folders per-user directory; only empty sunlnk directories may survive here. */
  sunlnk?: boolean;
}

export interface SweepResult {
  /** The user's own entries looked at. */
  seen: number;
  removed: number;
  /** What of the user is left (its path and why), and entries that couldn't be inspected. */
  left: string[];
  problems: string[];
  /** Reported, never a reason to fail: mount points met inside a root, others' trees deeper than the limit. */
  notes: string[];
  leftoverDirs: string[];
  /** False when the walk stopped early in the user's own subtree (too many entries, too deep). */
  complete: boolean;
}

export interface SweepOptions {
  remove: boolean;
  maxEntries?: number;
  maxDepth?: number;
  /** Tests: called before an entry is opened as a directory (to swap it for a symlink meanwhile). */
  beforeOpen?: (path: string) => void;
  /** Tests: the access check on others' directories (default canWriteAt; throws when it can't tell). */
  canWrite?: (dirfd: number, name: Uint8Array) => boolean;
  /** Tests: simulate descriptor operations and macOS's SIP-protected flags. */
  statAt?: typeof statAt;
  unlinkAt?: typeof unlinkAt;
}

const show = (dir: string, name: Uint8Array) => `${dir}/${Buffer.from(name).toString("utf8")}`;
const code = (err: unknown): string => (err instanceof FsatError ? err.code : "EIO");

export function sweep(roots: readonly SweepRoot[], owned: OwnedFn, opts: SweepOptions): SweepResult {
  const r: SweepResult = { seen: 0, removed: 0, left: [], problems: [], notes: [], leftoverDirs: [], complete: true };
  const max = opts.maxEntries ?? 2_000_000;
  const maxDepth = opts.maxDepth ?? 200;
  const note = (list: string[], s: string) => { if (list.length < 200) list.push(s); else if (list.length === 200) list.push("…"); };
  const recordLeftover = (path: string) => {
    if (r.leftoverDirs.length >= 200) note(r.problems, "more than 200 protected per-user directories remain");
    else r.leftoverDirs.push(path);
  };

  /** Its own entry `name` in `dirfd`, removed (its protections cleared and retried once when they are in the way). */
  const protectedEmptyDir = (dirfd: number, name: Uint8Array, path: string, original: StatAt): boolean => {
    try {
      const now = (opts.statAt ?? statAt)(dirfd, name);
      if (!isDir(now) || now.dev !== original.dev || now.ino !== original.ino || now.flags !== SF_NOUNLINK) return false;
      const fd = openDirAt(dirfd, name);
      try {
        const id = fdIdentity(fd);
        return id.ino === now.ino && id.dev === now.dev && listDir(fd).every((child) =>
          r.leftoverDirs.includes(show(path, child)));
      }
      finally { closeFd(fd); }
    } catch { return false; }
  };

  const remove = (dirfd: number, name: Uint8Array, path: string, dir: boolean, original: StatAt, sunlnk: boolean): void => {
    const attempt = () => (opts.unlinkAt ?? unlinkAt)(dirfd, name, dir);
    try { attempt(); r.removed++; return; } catch (err) {
      const c = code(err);
      if (c === "ENOENT") return;
      if (dir && (c === "ENOTEMPTY" || c === "EEXIST")) { note(r.left, `${path} (holds entries of others)`); return; }
      if (c !== "EPERM" && c !== "EACCES") { note(r.left, `${path}: ${c}`); return; }
    }
    try { clearProtections(dirfd, name, dir); attempt(); r.removed++; } catch (err) {
      const c = code(err);
      if (c === "ENOENT") return;
      if (sunlnk && dir && c === "EPERM" && protectedEmptyDir(dirfd, name, path, original)) {
        recordLeftover(path);
        return;
      }
      note(r.left, `${path}: its own ${dir ? "directory" : "file"} is protected and the protection couldn't be cleared (${c}: a system flag, or its parent's)`);
    }
  };

  const walk = (dirfd: number, dir: string, dev: number, dirOwned: boolean, depth: number, sunlnk: boolean): void => {
    if (depth > maxDepth) {
      if (dirOwned) { r.complete = false; note(r.problems, `${dir}: its own tree is deeper than ${maxDepth}`); } else note(r.notes, `${dir}: another owner's tree deeper than ${maxDepth}, not walked`);
      return;
    }
    let names: Uint8Array[];
    // Only directories it owns or may write (and the roots) are walked: failing to list one is never "verified"
    // (Codex r8 MEDIUM 3).
    try { names = listDir(dirfd); } catch (err) { note(r.problems, `${dir}: ${code(err)}`); return; }
    for (const name of names) {
      const path = show(dir, name);
      let st: StatAt;
      try { st = (opts.statAt ?? statAt)(dirfd, name); } catch (err) {
        if (code(err) !== "ENOENT") note(r.problems, `${path}: ${code(err)}`);
        continue;
      }
      if (st.dev !== dev) { note(sunlnk ? r.problems : r.notes, `${path}: a mount point, not crossed`); continue; }
      const mine = owned(st, name, dirOwned);
      if (sunlnk && !mine) note(r.left, `${path} (holds an entry of another user)`);
      if (mine && ++r.seen > max) { r.complete = false; note(r.problems, `more than ${max} of its own entries`); return; }
      if (isDir(st)) {
        // Others' directories only where the seat could have created entries (Opus r7 3).
        if (!mine) {
          // A check that fails (not a denial) is a problem, never a skip (Codex r9 MEDIUM 3).
          let writable: boolean;
          try { writable = (opts.canWrite ?? canWriteAt)(dirfd, name); } catch (err) { note(r.problems, `${path}: ${code(err)}`); continue; }
          if (!writable) continue;
        }
        if (mine) { try { clearProtections(dirfd, name, true); } catch { /* entered below, or reported when it can't be */ } }
        opts.beforeOpen?.(path);
        let fd: number;
        try { fd = openDirAt(dirfd, name); } catch (err) {
          const c = code(err);
          if (c === "ENOENT") continue;
          if (!mine && (c === "EACCES" || c === "EPERM")) continue; // another's it may not enter (not writable either)
          note(mine ? r.left : r.problems, `${path}: ${c}`);
          continue;
        }
        try {
          const id = fdIdentity(fd);
          if (id.ino !== st.ino || id.dev !== st.dev) { note(r.problems, `${path}: replaced while it was swept`); continue; }
          walk(fd, path, dev, mine, depth + 1, sunlnk && mine);
        } finally { closeFd(fd); }
        if (!r.complete) return;
        if (!mine) continue;
        if (!opts.remove) { note(r.left, path); continue; }
        remove(dirfd, name, path, true, st, sunlnk);
        continue;
      }
      if (!mine) continue;
      if (!opts.remove) { note(r.left, path); continue; }
      remove(dirfd, name, path, false, st, sunlnk);
    }
  };

  for (const root of roots) {
    // Its own root (its home, its per-user folder) may carry its own flags or ACL: cleared first, or nothing in it goes.
    if (root.owned && opts.remove) {
      try {
        const parent = openDirAt(AT_FDCWD(), dirname(root.path));
        try { clearProtections(parent, Buffer.from(basename(root.path)), true); } finally { closeFd(parent); }
      } catch { /* not there, or reported by what can't be removed inside it */ }
    }
    let fd: number;
    try { fd = openDirAt(AT_FDCWD(), root.path); } catch (err) {
      const c = code(err);
      // Absent is fine; a root of others it may not enter is only noted; anything else is not verified.
      if (c !== "ENOENT") note(!root.owned && (c === "EACCES" || c === "EPERM") ? r.notes : r.problems, `${root.path}: ${c}`);
      continue;
    }
    try {
      walk(fd, root.path.replace(/\/+$/, ""), fdIdentity(fd).dev, root.owned === true, 0, root.sunlnk === true);
    } finally { closeFd(fd); }
    if (root.sunlnk && root.owned && r.left.length === 0 && r.problems.length === 0 && r.complete) {
      try {
        const st = (opts.statAt ?? statAt)(AT_FDCWD(), root.path);
        if (isDir(st) && st.flags === SF_NOUNLINK) recordLeftover(root.path);
      } catch (err) { note(r.problems, `${root.path}: ${code(err)}`); }
    }
    if (!r.complete) break;
  }
  return r;
}

/**
 * Sweep, then verify with the same walk: passes (at most 3) until one removes nothing, finds nothing of the user and
 * has no inspection problem, complete. Anything else is not verified.
 */
export function sweepVerified(roots: readonly SweepRoot[], owned: OwnedFn, opts: Omit<SweepOptions, "remove"> = {}): {
  verified: boolean; removed: number; left: string[]; problems: string[]; notes: string[]; leftoverDirs: string[];
} {
  let removed = 0;
  let last: SweepResult | null = null;
  for (let pass = 0; pass < 3; pass++) {
    last = sweep(roots, owned, { ...opts, remove: true, beforeOpen: pass === 0 ? opts.beforeOpen : undefined });
    removed += last.removed;
    if (!last.complete) break;
    if (pass > 0 && last.removed === 0) break;
  }
  const r = last as SweepResult;
  const verified = r.complete && r.removed === 0 && r.left.length === 0 && r.problems.length === 0;
  return { verified, removed, left: r.left, problems: r.problems, notes: r.notes, leftoverDirs: r.leftoverDirs };
}
