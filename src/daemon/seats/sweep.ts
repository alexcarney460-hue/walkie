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
// last must remove nothing and find nothing of the user left, with no inspection problem. macOS can keep protected
// directories inside its own per-user folder; those paths are recorded separately for the destroy's final checks.
import { basename, dirname } from "node:path";
import {
  AT_FDCWD, FsatError, SF_NOUNLINK, SF_RESTRICTED, UF_DATAVAULT, S_IFMT, S_IFREG, canWriteAt, clearProtections, closeFd, fdIdentity, fileIdentity, hasExtendedAttributes, isDir, listDir, listExtendedAttributes, openDirAt, openFileAt, removeExtendedAttribute, statAt, truncateFile, unlinkAt, type StatAt,
} from "./fsat.ts";

/** Whether an entry is the sweeping user's (its uid; tests add their fake ownership). */
export type OwnedFn = (st: StatAt, name: Uint8Array, parentOwned: boolean) => boolean;

export interface SweepRoot {
  path: string;
  /** Whether the root directory itself is the user's (its home, its per-user folder): kept, never removed. */
  owned?: boolean;
  /** macOS's own /private/var/folders per-user directory; protected owned residue may survive here. */
  sunlnk?: boolean;
  /** Root-owned macOS cache whose direct children may be flagged Apple vaults. */
  systemVaults?: boolean;
  /** Seat home: root's known setup marker remains until the helper removes the home. */
  homeRoot?: boolean;
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
  residuePaths: string[];
  residueProofs: ResidueProof[];
  /** False when the walk stopped early in the user's own subtree (too many entries, too deep). */
  complete: boolean;
}

/** The runner's EPERM observation. A missing identity means stat itself returned EPERM. */
export interface ResidueProof { path: string; reason: string; dev?: number; ino?: number }

/**
 * Most protected-residue records one sweep reports. Past it the sweep fails closed. It also bounds the runner's
 * one-line JSON answer (about 155 bytes per record): Bun truncates a large stdout write followed by exit above a
 * few hundred KB, which would turn a verified sweep into "didn't answer".
 */
export const RESIDUE_RECORD_CAP = 2_000;

export interface SweepOptions {
  remove: boolean;
  /** Read-only check for a previous Talkie generation's accepted macOS residue. */
  residueOnly?: boolean;
  maxEntries?: number;
  maxDepth?: number;
  /** Tests: called before an entry is opened as a directory (to swap it for a symlink meanwhile). */
  beforeOpen?: (path: string) => void;
  /** Tests: the access check on others' directories (default canWriteAt; throws when it can't tell). */
  canWrite?: (dirfd: number, name: Uint8Array) => boolean;
  /** Tests: simulate descriptor operations and macOS's SIP-protected flags. */
  statAt?: typeof statAt;
  unlinkAt?: typeof unlinkAt;
  openDirAt?: typeof openDirAt;
  /** Root's empty-uid repair must report every subtree it could not inspect. */
  verifySkippedSubtrees?: boolean;
  openFileAt?: typeof openFileAt;
  hasExtendedAttributes?: typeof hasExtendedAttributes;
  listExtendedAttributes?: typeof listExtendedAttributes;
  removeExtendedAttribute?: typeof removeExtendedAttribute;
  listDir?: typeof listDir;
}

const show = (dir: string, name: Uint8Array) => `${dir}/${Buffer.from(name).toString("utf8")}`;
const code = (err: unknown): string => (err instanceof FsatError ? err.code : "EIO");
const UF_HIDDEN = 0x00008000;
const qualifyingFlags = SF_NOUNLINK | SF_RESTRICTED | UF_DATAVAULT;
const protectedFlags = (flags: number | undefined): boolean =>
  ((flags ?? 0) & qualifyingFlags) !== 0 && ((flags ?? 0) & ~(qualifyingFlags | UF_HIDDEN)) === 0;
const vaultFlags = (flags: number | undefined): boolean =>
  ((flags ?? 0) & (SF_RESTRICTED | UF_DATAVAULT)) !== 0
    && ((flags ?? 0) & ~(SF_NOUNLINK | SF_RESTRICTED | UF_DATAVAULT | UF_HIDDEN)) === 0;
const flagReason = (flags: number | undefined): string => [
  ((flags ?? 0) & SF_NOUNLINK) && "SF_NOUNLINK",
  ((flags ?? 0) & SF_RESTRICTED) && "SF_RESTRICTED",
  ((flags ?? 0) & UF_DATAVAULT) && "UF_DATAVAULT",
].filter(Boolean).join(", ");
const sameDir = (a: StatAt, b: StatAt): boolean =>
  isDir(a) && isDir(b) && a.uid === b.uid && a.dev === b.dev && a.ino === b.ino;
const allowedResidueFlags = (flags: number | undefined): boolean =>
  ((flags ?? 0) & ~(qualifyingFlags | UF_HIDDEN)) === 0;
const systemAttribute = (name: Uint8Array): boolean =>
  ["com.apple.rootless", "com.apple.provenance"].some((n) => Buffer.from(name).equals(Buffer.from(n)));
const attributeLabel = (name: Uint8Array): string => {
  const text = Buffer.from(name).toString("utf8");
  return Buffer.from(text).equals(Buffer.from(name)) ? JSON.stringify(text) : `hex:${Buffer.from(name).toString("hex")}`;
};

export function sweep(roots: readonly SweepRoot[], owned: OwnedFn, opts: SweepOptions): SweepResult {
  const r: SweepResult = { seen: 0, removed: 0, left: [], problems: [], notes: [], leftoverDirs: [], residuePaths: [], residueProofs: [], complete: true };
  const max = opts.maxEntries ?? 2_000_000;
  const maxDepth = opts.maxDepth ?? 200;
  const residues = new Set<string>();
  const residueIds = new Map<string, StatAt | null>();
  const opaque = new Set<string>();
  let residueCapReported = false;
  const note = (list: string[], s: string) => { if (list.length < 200) list.push(s); else if (list.length === 200) list.push("…"); };
  const recordLeftover = (path: string, why: string, st: StatAt | null) => {
    if (residues.has(path)) return;
    if (residues.size >= RESIDUE_RECORD_CAP) {
      if (residueCapReported) return;
      residueCapReported = true;
      const cap = `protected per-user residue cap hit (${RESIDUE_RECORD_CAP} entries)`;
      r.left.unshift(cap); // runner summaries show the first left entries even when many other leftovers precede it
      r.problems.push(cap);
      return;
    }
    residues.add(path);
    r.residuePaths.push(path);
    r.residueProofs.push({ path, reason: why.includes("EPERM") ? why : "EPERM in protected descendant", ...(st ? { dev: st.dev, ino: st.ino } : {}) });
    residueIds.set(path, st);
    r.leftoverDirs.push(st
      ? `${path} (${[why, flagReason(st.flags)].filter(Boolean).join("; ")}; flags=0x${(st.flags ?? 0).toString(16).padStart(8, "0")})`
      : `${path} (${why})`);
  };

  const cleanDirectoryAttributes = (fd: number, path: string): void => {
    const list = opts.listExtendedAttributes ?? listExtendedAttributes;
    let names: Uint8Array[];
    try { names = list(fd); } catch (err) { note(r.problems, `${path}: directory attributes cannot be listed (${code(err)})`); return; }
    for (const name of names) {
      const label = attributeLabel(name);
      if (systemAttribute(name)) { note(r.notes, `${path}: system attribute ${label} remains`); continue; }
      if (!opts.remove) { note(r.problems, `${path}: directory attribute ${label} remains`); continue; }
      try { (opts.removeExtendedAttribute ?? removeExtendedAttribute)(fd, name); }
      catch (err) { note(r.problems, `${path}: directory attribute ${label} could not be removed (${code(err)})`); }
    }
    if (!opts.remove) return;
    try {
      for (const name of list(fd)) if (!systemAttribute(name))
        note(r.problems, `${path}: directory attribute ${attributeLabel(name)} remains after removal`);
    } catch (err) { note(r.problems, `${path}: directory attributes cannot be rechecked (${code(err)})`); }
  };

  /** EPERM is accepted only under a freshly checked chain of owned, unchanged directories. */
  const opaqueDir = (dirfd: number, name: Uint8Array | string, original: StatAt,
    parentCheck: () => StatAt | null, operation: string, root = false): { stat: StatAt | null; why: string } | null => {
    if (!parentCheck()) return null;
    try {
      const now = (opts.statAt ?? statAt)(dirfd, name);
      if (!sameDir(now, original)) return null;
      if (root && !protectedFlags(now.flags)) return null;
      return { stat: now, why: `EPERM ${operation}` };
    } catch (err) {
      return !root && code(err) === "EPERM" ? { stat: null, why: `EPERM ${operation}; EPERM stat recheck` } : null;
    }
  };
  const verifiedVault = (dirfd: number, name: Uint8Array | string, original: StatAt): boolean => {
    if (!vaultFlags(original.flags)) return false;
    try {
      const now = (opts.statAt ?? statAt)(dirfd, name);
      return sameDir(now, original) && vaultFlags(now.flags);
    } catch { return false; }
  };
  const emptyVault = (dirfd: number, name: Uint8Array, original: StatAt): boolean => {
    if (!verifiedVault(dirfd, name, original)) return false;
    let fd: number;
    try { fd = (opts.openDirAt ?? openDirAt)(dirfd, name); } catch { return false; }
    try {
      const id = fdIdentity(fd);
      return id.dev === original.dev && id.ino === original.ino && (opts.listDir ?? listDir)(fd).length === 0;
    } catch { return false; }
    finally { closeFd(fd); }
  };

  /** A readable regular file must be emptied on the same inode before it may survive unlink EPERM. */
  const protectedFile = (dirfd: number, name: Uint8Array, path: string, original: StatAt,
    parentCheck: () => StatAt | null, mayTruncate: boolean): string | null => {
    const attributesClear = (fd: number): boolean => {
      try {
        if (!(opts.hasExtendedAttributes ?? hasExtendedAttributes)(fd)) return true;
        note(r.problems, `${path}: protected file carries extended attributes`);
      } catch { note(r.problems, `${path}: protected file extended attribute listing failed`); }
      return false;
    };
    if (!parentCheck()) return null;
    let now: StatAt;
    try {
      now = (opts.statAt ?? statAt)(dirfd, name);
      if ((now.mode & S_IFMT) !== S_IFREG || now.mode !== original.mode || now.uid !== original.uid
        || now.dev !== original.dev || now.ino !== original.ino) return null;
    } catch (err) { return code(err) === "EPERM" ? "EPERM stat recheck" : null; }
    let readfd: number;
    try { readfd = (opts.openFileAt ?? openFileAt)(dirfd, name, false); }
    catch (err) { return code(err) === "EPERM" ? "EPERM read-open" : null; }
    try {
      const id = fileIdentity(readfd);
      if (id.dev !== now.dev || id.ino !== now.ino || id.uid !== now.uid || (id.mode & S_IFMT) !== S_IFREG
        || id.nlink !== 1 || !protectedFlags(now.flags)) return null;
      if (!attributesClear(readfd)) return null;
      if (!mayTruncate) return id.size === 0 ? "empty protected file" : null;
    } catch { return null; }
    finally { closeFd(readfd); }
    let writefd: number;
    try { writefd = (opts.openFileAt ?? openFileAt)(dirfd, name, true); } catch { return null; }
    try {
      const before = fileIdentity(writefd);
      if (before.dev !== now.dev || before.ino !== now.ino || before.uid !== now.uid
        || (before.mode & S_IFMT) !== S_IFREG || before.nlink !== 1 || !parentCheck()
        || !attributesClear(writefd)) return null;
      truncateFile(writefd);
      const after = fileIdentity(writefd);
      return after.dev === before.dev && after.ino === before.ino && after.nlink === 1 && after.size === 0
        ? "truncated to 0 after EPERM unlink" : null;
    } catch { return null; }
    finally { closeFd(writefd); }
  };

  const stillOpaque = (dirfd: number, name: Uint8Array, st: StatAt): boolean => {
    let fd: number;
    try { fd = (opts.openDirAt ?? openDirAt)(dirfd, name); }
    catch (err) { return code(err) === "EPERM"; }
    try {
      const id = fdIdentity(fd);
      if (id.dev !== st.dev || id.ino !== st.ino) return false;
      try { (opts.listDir ?? listDir)(fd); return false; }
      catch (err) { return code(err) === "EPERM"; }
    } catch { return false; }
    finally { closeFd(fd); }
  };

  /** A listable directory may retain only verified opaque entries or empty protected files; recheck each child. */
  const protectedDir = (dirfd: number, name: Uint8Array, path: string, original: StatAt,
    parentCheck: () => StatAt | null): { stat: StatAt | null } | null => {
    try {
      if (opaque.has(path)) return opaqueDir(dirfd, name, original, parentCheck, "open");
      if (!parentCheck()) return null;
      const now = (opts.statAt ?? statAt)(dirfd, name);
      if (!sameDir(now, original) || !allowedResidueFlags(now.flags)) return null;
      const fd = (opts.openDirAt ?? openDirAt)(dirfd, name);
      try {
        const id = fdIdentity(fd);
        if (id.ino !== now.ino || id.dev !== now.dev) return null;
        const children = (opts.listDir ?? listDir)(fd);
        const onlyResidue = children.every((child) => {
          const recorded = residueIds.get(show(path, child));
          if (recorded === undefined) return false;
          try {
            const current = (opts.statAt ?? statAt)(fd, child);
            return recorded !== null && current.uid === original.uid && (
              (sameDir(current, recorded) && (opaque.has(show(path, child))
                ? stillOpaque(fd, child, current) : allowedResidueFlags(current.flags)))
              || (current.dev === recorded.dev && current.ino === recorded.ino
                && protectedFile(fd, child, show(path, child), recorded, () => now, false) !== null));
          } catch (err) { return recorded === null && code(err) === "EPERM"; }
        })
          && (children.length > 0 || protectedFlags(now.flags));
        return onlyResidue ? { stat: now } : null;
      }
      finally { closeFd(fd); }
    } catch { return null; }
  };
  const remove = (dirfd: number, name: Uint8Array, path: string, dir: boolean, original: StatAt, sunlnk: boolean, vault: boolean,
    parentCheck: () => StatAt | null): void => {
    const attempt = () => (opts.unlinkAt ?? unlinkAt)(dirfd, name, dir);
    try { attempt(); r.removed++; return; } catch (err) {
      const c = code(err);
      if (c === "ENOENT") return;
      if (dir && (c === "ENOTEMPTY" || c === "EEXIST")) {
        const protectedSt = sunlnk ? protectedDir(dirfd, name, path, original, parentCheck) : null;
        if (protectedSt) { recordLeftover(path, "unlink ENOTEMPTY; holds protected residue", protectedSt.stat); return; }
        note(r.left, `${path} (holds entries of others)`); return;
      }
      if (c !== "EPERM" && c !== "EACCES") { note(r.left, `${path}: ${c}`); return; }
    }
    let stage = "clearing protections";
    try { clearProtections(dirfd, name, dir); stage = "unlink"; attempt(); r.removed++; } catch (err) {
      const c = code(err);
      if (c === "ENOENT") return;
      const protectedSt = sunlnk && c === "EPERM" && dir ? protectedDir(dirfd, name, path, original, parentCheck) : null;
      const vaultSt = vault && c === "EPERM" && dir && emptyVault(dirfd, name, original) ? original : null;
      const fileWhy = sunlnk && c === "EPERM" && !dir ? protectedFile(dirfd, name, path, original, parentCheck, true) : null;
      if (protectedSt || vaultSt || fileWhy) {
        recordLeftover(path, fileWhy ?? `EPERM ${stage}; macOS protection prevents removal`, protectedSt ? protectedSt.stat : original);
        return;
      }
      note(r.left, `${path}: its own ${dir ? "directory" : "file"} is protected and the protection couldn't be cleared (${c}: a system flag, or its parent's)`);
    }
  };

  const walk = (dirfd: number, dir: string, dev: number, dirOwned: boolean, depth: number, sunlnk: boolean,
    current?: StatAt, parentfd?: number, entryName?: Uint8Array | string,
    parentCheck?: () => StatAt | null, systemVault = false, homeRoot = false): void => {
    if (depth > maxDepth) {
      if (dirOwned) { r.complete = false; note(r.problems, `${dir}: its own tree is deeper than ${maxDepth}`); } else note(r.notes, `${dir}: another owner's tree deeper than ${maxDepth}, not walked`);
      return;
    }
    let names: Uint8Array[];
    const checkCurrent = (): StatAt | null => {
      if (!sunlnk || !dirOwned || !current || parentfd === undefined || entryName === undefined || !parentCheck?.()) return null;
      try {
        const now = (opts.statAt ?? statAt)(parentfd, entryName);
        const id = fdIdentity(dirfd);
        return sameDir(now, current) && now.uid === current.uid && now.dev === dev
          && id.dev === now.dev && id.ino === now.ino ? now : null;
      } catch { return null; }
    };
    // The sweep runs as the seat user; EPERM here is the kernel's protected-residue signal.
    try { names = (opts.listDir ?? listDir)(dirfd); } catch (err) {
      const accepted = sunlnk && dirOwned && current && parentfd !== undefined && entryName !== undefined && code(err) === "EPERM"
        ? opaqueDir(parentfd, entryName, current, parentCheck ?? (() => null), "list", depth === 0) : null;
      const vault = systemVault && current && parentfd !== undefined && entryName !== undefined && code(err) === "EPERM"
        && verifiedVault(parentfd, entryName, current);
      if (accepted || vault) {
        if (residues.size < RESIDUE_RECORD_CAP) opaque.add(dir);
        recordLeftover(dir, accepted?.why ?? "EPERM listing Apple data vault", accepted?.stat ?? current ?? null);
      } else note(r.problems, `${dir}: ${code(err)}`);
      return;
    }
    if (sunlnk && dirOwned) {
      if (!checkCurrent()) { note(r.problems, `${dir}: its owned directory changed before attribute cleanup`); return; }
      cleanDirectoryAttributes(dirfd, dir);
    }
    for (const name of names) {
      const path = show(dir, name);
      let st: StatAt;
      try { st = (opts.statAt ?? statAt)(dirfd, name); } catch (err) {
        if (code(err) === "EPERM" && sunlnk && dirOwned && checkCurrent()) {
          recordLeftover(path, "EPERM stat", null);
          continue;
        }
        if (code(err) !== "ENOENT") note(r.problems, `${path}: ${code(err)}`);
        continue;
      }
      if (st.dev !== dev) { note(sunlnk || systemVault ? r.problems : r.notes, `${path}: a mount point, not crossed`); continue; }
      const mine = owned(st, name, dirOwned);
      if (homeRoot && depth === 0 && Buffer.from(name).toString() === ".walkie-seat-home" && !mine) continue;
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
        if (mine && opts.remove) { try { clearProtections(dirfd, name, true); } catch { /* entered below, or reported when it can't be */ } }
        opts.beforeOpen?.(path);
        let fd: number;
        try { fd = (opts.openDirAt ?? openDirAt)(dirfd, name); } catch (err) {
          const c = code(err);
          if (c === "ENOENT") continue;
          if (!mine && (c === "EACCES" || c === "EPERM")) {
            if (opts.verifySkippedSubtrees) note(r.notes, `${path}: ${c}, not inspected`);
            continue; // ordinary seat sweep cannot enter another owner's protected directory
          }
          if ((sunlnk || systemVault && depth === 0) && mine && c === "EPERM") {
            const accepted = systemVault && depth === 0 && verifiedVault(dirfd, name, st)
              ? { stat: st, why: "EPERM opening Apple data vault" }
              : sunlnk ? opaqueDir(dirfd, name, st, checkCurrent, "open") : null;
            if (accepted) {
              if (residues.size < RESIDUE_RECORD_CAP) opaque.add(path);
              recordLeftover(path, accepted.why, accepted.stat);
            }
            else note(r.left, `${path}: EPERM opening its owned directory without verified system protection`);
            continue;
          }
          note(mine ? r.left : r.problems, `${path}: ${c}`);
          continue;
        }
        try {
          const id = fdIdentity(fd);
          if (id.ino !== st.ino || id.dev !== st.dev) { note(r.problems, `${path}: replaced while it was swept`); continue; }
          walk(fd, path, dev, mine, depth + 1, sunlnk && mine, st, dirfd, name, checkCurrent, systemVault && depth === 0);
        } finally { closeFd(fd); }
        if (!r.complete) return;
        if (!mine) continue;
        if (!opts.remove) {
          const protectedSt = opts.residueOnly && sunlnk ? protectedDir(dirfd, name, path, st, checkCurrent) : null;
          if (protectedSt) recordLeftover(path, "holds protected residue in read-only walk", protectedSt.stat);
          else note(r.left, path);
          continue;
        }
        remove(dirfd, name, path, true, st, sunlnk, systemVault && depth === 0, checkCurrent);
        continue;
      }
      if (!mine) continue;
      if (!opts.remove) {
        const fileWhy = opts.residueOnly && sunlnk ? protectedFile(dirfd, name, path, st, checkCurrent, false) : null;
        if (fileWhy) recordLeftover(path, fileWhy, st);
        else note(r.left, path);
        continue;
      }
      remove(dirfd, name, path, false, st, sunlnk, false, checkCurrent);
    }
  };

  for (const root of roots) {
    let ownFolder = false;
    let rootStat: StatAt | undefined;
    if (root.sunlnk && root.owned) {
      try {
        const st = (opts.statAt ?? statAt)(AT_FDCWD(), root.path);
        ownFolder = isDir(st) && owned(st, Buffer.from(basename(root.path)), true);
        if (ownFolder) rootStat = st;
        if (!ownFolder) note(r.problems, `${root.path}: per-user folder is not owned by the seat uid`);
      } catch (err) {
        if (code(err) !== "ENOENT") note(r.problems, `${root.path}: cannot verify per-user folder ownership (${code(err)})`);
      }
      if (!ownFolder) continue;
    }
    // Its own root (its home, its per-user folder) may carry its own flags or ACL: cleared first, or nothing in it goes.
    if (root.owned && opts.remove) {
      try {
        const parent = openDirAt(AT_FDCWD(), dirname(root.path));
        try { clearProtections(parent, Buffer.from(basename(root.path)), true); } finally { closeFd(parent); }
      } catch { /* not there, or reported by what can't be removed inside it */ }
    }
    let fd: number;
    try { fd = (opts.openDirAt ?? openDirAt)(AT_FDCWD(), root.path); } catch (err) {
      const c = code(err);
      if (ownFolder && rootStat && c === "EPERM") {
        const accepted = opaqueDir(AT_FDCWD(), root.path, rootStat, () => rootStat ?? null, "open", true);
        if (accepted) recordLeftover(root.path, "EPERM opening its owned per-user directory", accepted.stat);
        else note(r.problems, `${root.path}: EPERM opening its owned per-user directory without verified system protection`);
        continue;
      }
      // Absent is fine; a root of others it may not enter is only noted; anything else is not verified.
      if (c !== "ENOENT") note(!root.owned && !root.systemVaults && (c === "EACCES" || c === "EPERM") ? r.notes : r.problems, `${root.path}: ${c}`);
      continue;
    }
    try {
      const id = fdIdentity(fd);
      if (rootStat && (rootStat.dev !== id.dev || rootStat.ino !== id.ino)) {
        note(r.problems, `${root.path}: per-user folder was replaced while it was swept`);
        continue;
      }
      walk(fd, root.path.replace(/\/+$/, ""), id.dev, root.owned === true, 0, ownFolder, rootStat, AT_FDCWD(), root.path,
        () => rootStat ?? null, root.systemVaults === true, root.homeRoot === true);
    } finally { closeFd(fd); }
    if (root.sunlnk && root.owned && r.left.length === 0 && r.problems.length === 0 && r.complete) {
      try {
        const st = (opts.statAt ?? statAt)(AT_FDCWD(), root.path);
        if (rootStat && sameDir(st, rootStat) && protectedFlags(st.flags))
          recordLeftover(root.path, "macOS system protection", st);
      } catch (err) { note(r.problems, `${root.path}: ${code(err)}`); }
    }
    if (!r.complete) break;
  }
  return r;
}

/** Read-only recheck before a later WalkieTalkie generation can reuse its fixed uid. */
export function verifyProtectedResidue(folder: string, uid: number,
  opts: Omit<SweepOptions, "remove" | "residueOnly"> = {}): { verified: boolean; leftoverDirs: string[] } {
  const r = sweep([{ path: folder, owned: true, sunlnk: true }], (st) => st.uid === uid,
    { ...opts, remove: false, residueOnly: true });
  return { verified: r.complete && r.left.length === 0 && r.problems.length === 0,
    leftoverDirs: r.leftoverDirs };
}

/**
 * Sweep, then verify with the same walk: passes (at most 3) until one removes nothing, finds nothing of the user and
 * has no inspection problem, complete. Anything else is not verified.
 */
export function sweepVerified(roots: readonly SweepRoot[], owned: OwnedFn, opts: Omit<SweepOptions, "remove"> = {}): {
  verified: boolean; removed: number; left: string[]; problems: string[]; notes: string[]; leftoverDirs: string[]; residuePaths: string[]; residueProofs: ResidueProof[];
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
  return { verified, removed, left: r.left, problems: r.problems, notes: r.notes, leftoverDirs: r.leftoverDirs, residuePaths: r.residuePaths, residueProofs: r.residueProofs };
}
