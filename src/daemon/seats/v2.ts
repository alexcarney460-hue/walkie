// Seats v2 (FO-2, FLEET-ORCH-1 §3.4): the brief as TASK.md in the work tree (argv carries only a fixed pointer to
// it), a workspace in the host's own clone of a repo (a worktree for same-user seats, a privately staged bundle of the
// exact commit for seat users), and the result file read back without following a symlink. Every git call goes through
// git.ts (no system or global config, program-running settings off, its own process group); calls that check files
// out in the person's clone also neutralize the filter drivers its config defines (filterOverrides).
//
// What Walkie owns in the person's clone (FO-2 r1 HIGH 1/2): worktrees under `.worktrees/<label>` it made (a marker
// file in the worktree's admin directory, never in its tree) and branches `lane/…` / `walkie/…` it created (an
// ownership ref `refs/walkie/lanes/<branch>`). Anything else of that name is refused, never reset or removed.
import {
  appendFileSync, chmodSync, closeSync, fsyncSync, linkSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync,
  rmSync, rmdirSync, statSync, writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { redactSecrets } from "../../protocol/safety.ts";
import {
  MAX_RESULT_FILE, SEAT_TASK_FILE, SEAT_TASK_FILE_ALT, SEAT_TASK_PROMPT, SEAT_TASK_PROMPT_ALT, SeatResultFile, type SeatWorkspace,
} from "../../protocol/seats.ts";
import { GitConfigError, filterOverrides, git, gitToFile } from "./git.ts";

/** A v2 request the host refuses before running anything (posted as the `refused` reason). */
export class SeatRefusal extends Error {}

// ---- the brief ----------------------------------------------------------------------------------------------

/** The brief as text: UTF-8, no NUL; null when it isn't. */
export function briefText(bytes: Uint8Array, max: number): string | null {
  if (bytes.byteLength === 0 || bytes.byteLength > max) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/**
 * Where the brief lands in the work tree and the fixed prompt pointing at it; `exclude`: the repository exclude
 * file that hides it from `git add` while seats run (releaseExclude takes the lines out again); `hash`: the brief's
 * sha256, so cleanup only ever removes the brief itself (never a file of the person's that took its name).
 */
export interface TaskFile {
  file: string; prompt: string; exclude?: string; hash?: string;
  /**
   * The brief is written here first (a unique name of Walkie's next to it, in the plan: FO-2 r3 MED 3), fsynced, then
   * published under `file` in one step; a crash mid-write leaves only this, which cleanup removes whatever it holds.
   */
  tmp?: string;
}

/** The line before each pattern Walkie adds to a repository's info/exclude (so it can take exactly those out). */
const EXCLUDE_MARK = "# walkie seat brief (removed when no seat runs in this clone)";
/** The line before the lanes' worktree directory in a clone's info/exclude (kept: the worktrees stay). */
const WORKTREES_MARK = "# walkie seats: lane worktrees (.worktrees/<label>)";

export function briefHash(brief: string): string { return createHash("sha256").update(brief).digest("hex"); }

/**
 * Where the brief will go in `cwd`, before anything is written (FO-2 r2 MED 2: the caller records this durably
 * first): `TASK.md`, or `.walkie/TASK.md` when the tree has a TASK.md of its own (a tracked file is never
 * overwritten), and the repository's exclude file when `cwd` is a git work tree.
 */
export async function planTask(cwd: string, brief: string, env: Record<string, string>, signal?: AbortSignal): Promise<TaskFile> {
  const taken = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
  let task: TaskFile = { file: SEAT_TASK_FILE, prompt: SEAT_TASK_PROMPT, hash: briefHash(brief), tmp: `.walkie-brief-${randomBytes(12).toString("hex")}.tmp` };
  if (taken(join(cwd, SEAT_TASK_FILE))) {
    const dir = join(cwd, ".walkie");
    if (taken(dir)) {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("the work tree has a TASK.md and a .walkie that isn't a directory: the brief has nowhere to go");
    }
    task = { ...task, file: SEAT_TASK_FILE_ALT, prompt: SEAT_TASK_PROMPT_ALT };
  }
  const exclude = await excludeFileOf(cwd, env, signal);
  return exclude ? { ...task, exclude } : task;
}

/**
 * Writes the planned brief (created exclusively, never through a planted symlink, 0600), lists it in the
 * repository's exclude file, and checks that it is really ignored (fail closed, FO-2 r1 MEDIUM 5: a .gitignore
 * negation outranks info/exclude). On any failure what it wrote is taken out again, then it throws.
 */
export async function placeTask(cwd: string, brief: string, task: TaskFile, env: Record<string, string>, signal?: AbortSignal): Promise<TaskFile> {
  if (task.file === SEAT_TASK_FILE_ALT && !existsSync(join(cwd, ".walkie"))) mkdirSync(join(cwd, ".walkie"), { mode: 0o700 });
  // Atomic (FO-2 r3 MED 3): written whole and fsynced under the planned temporary name, then linked under its name
  // (fails if that exists, never through a planted symlink), then the temporary name goes. A partial write is only
  // ever the temporary file, which cleanup removes by name.
  const tmp = task.tmp ? join(cwd, task.tmp) : null;
  if (tmp) {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, brief); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(tmp, join(cwd, task.file)); } finally { rmSync(tmp, { force: true }); }
  } else {
    writeFileSync(join(cwd, task.file), brief, { mode: 0o600, flag: "wx" });
  }
  if (!task.exclude) {
    if (!existsSync(join(cwd, ".git"))) return task; // not a repository: nothing can commit it
    removeTask(cwd, task);
    throw new SeatRefusal("the brief can't be kept out of this repository's commits (its exclude file can't be found): nothing ran");
  }
  try {
    const cur = existsSync(task.exclude) ? readFileSync(task.exclude, "utf8") : "";
    const block = `${EXCLUDE_MARK}\n${patternOf(task)}\n`;
    if (!cur.includes(block)) {
      mkdirSync(dirname(task.exclude), { recursive: true });
      appendFileSync(task.exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}${block}`);
    }
  } catch { /* checked below */ }
  const ignored = await git(["check-ignore", "-q", "--", task.file], cwd, env, { signal });
  if (ignored.code !== 0) {
    removeTask(cwd, task);
    releaseExclude(task);
    throw new SeatRefusal(`the brief can't be kept out of this repository's commits (a .gitignore rule re-includes ${task.file}, or its info/exclude can't be written): nothing ran`);
  }
  return task;
}

/** Plans and places the brief in one go (a seat user's runner, in its own clone: nothing to recover there). */
export async function writeTask(cwd: string, brief: string, env: Record<string, string>, signal?: AbortSignal): Promise<TaskFile> {
  return placeTask(cwd, brief, await planTask(cwd, brief, env, signal), env, signal);
}

/** The work tree's repository exclude file (`<common git dir>/info/exclude`), or undefined outside a git tree. */
async function excludeFileOf(cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<string | undefined> {
  if (!existsSync(join(cwd, ".git"))) return undefined;
  const r = await git(["rev-parse", "--git-common-dir"], cwd, env, { signal });
  if (r.code !== 0 || !r.out) return undefined;
  return join(isAbsolute(r.out) ? r.out : resolve(cwd, r.out), "info", "exclude");
}

function patternOf(task: TaskFile): string { return task.file === SEAT_TASK_FILE ? "/TASK.md" : "/.walkie/"; }

/**
 * Adds the brief's pattern (after EXCLUDE_MARK) to the work tree's repository info/exclude (its common git
 * directory, shared by its worktrees), once; returns that file. No repo, or it can't be written: undefined.
 */
async function excludeFromGit(cwd: string, pattern: string, env: Record<string, string>, signal?: AbortSignal, mark = EXCLUDE_MARK): Promise<string | undefined> {
  if (!existsSync(join(cwd, ".git"))) return undefined;
  const r = await git(["rev-parse", "--git-common-dir"], cwd, env, { signal });
  if (r.code !== 0 || !r.out) return undefined;
  const common = isAbsolute(r.out) ? r.out : resolve(cwd, r.out);
  const info = join(common, "info");
  const file = join(info, "exclude");
  try {
    mkdirSync(info, { recursive: true });
    const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!cur.includes(`${mark}\n${pattern}\n`)) appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}${mark}\n${pattern}\n`);
    return file;
  } catch {
    return undefined; // best effort: the brief is still taken out before the tree is inspected (removeTask)
  }
}

/** Takes the brief's pattern (and its mark) out of a repository exclude file again (the last seat there ended). */
export function releaseExclude(task: TaskFile | null): void {
  if (!task?.exclude) return;
  try {
    const cur = readFileSync(task.exclude, "utf8");
    const next = cur.split(`${EXCLUDE_MARK}\n${patternOf(task)}\n`).join("");
    if (next !== cur) writeFileSync(task.exclude, next);
  } catch { /* gone */ }
}

/** A persisted brief record (seats.json `running[].task`) as this daemon writes it, or false. */
export function validTaskRecord(v: unknown): v is { cwd: string; file: string; exclude?: string; hash?: string; tmp?: string } {
  const t = v as { cwd?: unknown; file?: unknown; exclude?: unknown; hash?: unknown } | null;
  if (t && typeof t === "object" && t.hash !== undefined && (typeof t.hash !== "string" || !/^[0-9a-f]{64}$/.test(t.hash))) return false;
  if (t && typeof t === "object" && (t as { tmp?: unknown }).tmp !== undefined && !/^\.walkie-brief-[0-9a-f]{24}\.tmp$/.test(String((t as { tmp?: unknown }).tmp))) return false;
  if (!t || typeof t !== "object" || typeof t.cwd !== "string" || !isAbsolute(t.cwd) || t.cwd.includes("\u0000")) return false;
  if (t.file !== SEAT_TASK_FILE && t.file !== SEAT_TASK_FILE_ALT) return false;
  return t.exclude === undefined || (typeof t.exclude === "string" && isAbsolute(t.exclude) && t.exclude.endsWith("/info/exclude"));
}

/** A persisted lane record (seats.json `running[].lane`) as this daemon writes it, or false. */
export function validLaneRecord(v: unknown): v is { clone: string; branch: string } {
  const t = v as { clone?: unknown; branch?: unknown } | null;
  return !!t && typeof t === "object" && typeof t.clone === "string" && isAbsolute(t.clone) && !t.clone.includes("\u0000")
    && typeof t.branch === "string" && /^(?:lane|walkie)\/[a-z0-9][a-z0-9._/-]{0,130}$/.test(t.branch) && !t.branch.includes("..");
}

/** Removes the brief before the work tree is inspected (it is no work of the seat's). */
export function removeTask(cwd: string, task: TaskFile | null): void {
  if (!task) return;
  if (task.tmp && /^\.walkie-brief-[0-9a-f]{24}\.tmp$/.test(task.tmp)) {
    try { if (lstatSync(join(cwd, task.tmp)).isFile()) rmSync(join(cwd, task.tmp), { force: true }); } catch { /* gone */ }
  }
  const path = join(cwd, task.file);
  try {
    // Only the brief itself: a file that took its name and holds anything else is the person's (FO-2 r2 MED 2).
    const st = lstatSync(path);
    const ours = st.isFile() && (!task.hash || createHash("sha256").update(readFileSync(path)).digest("hex") === task.hash);
    if (ours) rmSync(path, { force: true });
  } catch { /* gone */ }
  if (task.file === SEAT_TASK_FILE_ALT) {
    try { rmdirSync(join(cwd, ".walkie")); } catch { /* not empty (the seat put more there), or gone */ }
  }
}

// ---- the result file ---------------------------------------------------------------------------------------------

export type ResultFile = { bytes: Uint8Array } | { error: string };

/**
 * The seat's result file (`rel` inside `root`): every directory on the way is a real directory (never a symlink),
 * the file itself is opened with O_NOFOLLOW and must be a regular file of at most MAX_RESULT_FILE bytes of UTF-8
 * text. Secrets in it are redacted (the file goes to the launcher as an artifact).
 */
export function readResultFile(root: string, rel: string): ResultFile {
  if (!SeatResultFile.safeParse(rel).success) return { error: "not a relative path inside the work tree" };
  const segs = rel.split("/");
  // Node has no openat: each directory on the way is checked (a real directory, never a symlink) before the open and
  // again after it, by device and inode; the opened file must be the one lstat saw. A swap in between is refused.
  const dirs: Array<{ path: string; dev: number; ino: number }> = [];
  let cur = root;
  for (const seg of ["", ...segs.slice(0, -1)]) {
    cur = seg ? join(cur, seg) : cur;
    let st;
    try { st = lstatSync(cur); } catch { return { error: "not found" }; }
    if (st.isSymbolicLink()) return { error: "refused: a symlink on its path" };
    if (!st.isDirectory()) return { error: "not found" };
    dirs.push({ path: cur, dev: st.dev, ino: st.ino });
  }
  const path = join(cur, segs[segs.length - 1] as string);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { error: code === "ELOOP" ? "refused: it is a symlink" : code === "ENOENT" ? "not found" : "could not be opened" };
  }
  try {
    const st = fstatSync(fd);
    const same = (() => {
      try {
        const l = lstatSync(path);
        return l.dev === st.dev && l.ino === st.ino && dirs.every((d) => { const x = lstatSync(d.path); return !x.isSymbolicLink() && x.dev === d.dev && x.ino === d.ino; });
      } catch { return false; }
    })();
    if (!same) return { error: "refused: its path changed while it was read" };
    if (!st.isFile()) return { error: "not a regular file" };
    if (st.size > MAX_RESULT_FILE) return { error: `over ${MAX_RESULT_FILE / 1024} KiB` };
    const buf = new Uint8Array(st.size);
    let off = 0;
    while (off < buf.byteLength) {
      const n = readSync(fd, buf, off, buf.byteLength - off, off);
      if (n <= 0) break;
      off += n;
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, off)); } catch { return { error: "not UTF-8 text" }; }
    return { bytes: new TextEncoder().encode(redactSecrets(text).text) };
  } finally {
    closeSync(fd);
  }
}

// ---- the workspace -----------------------------------------------------------------------------------------------

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A bundle file's header (v2/v3): its prerequisite commits (`-<id>`) and heads (`<id> <ref>`); null when malformed. */
export function bundleHeader(file: string): { prereqs: string[]; heads: Array<{ sha: string; ref: string }> } | null {
  let text: string;
  try {
    const fd = openSync(file, "r");
    try {
      const buf = new Uint8Array(1024 * 1024);
      const n = readSync(fd, buf, 0, buf.byteLength, 0);
      const head = new TextDecoder().decode(buf.subarray(0, n));
      const stop = head.indexOf("\n\n");
      if (stop < 0) return null;
      text = head.slice(0, stop);
    } finally { closeSync(fd); }
  } catch { return null; }
  const lines = text.split("\n");
  if (lines[0] !== "# v2 git bundle" && lines[0] !== "# v3 git bundle") return null;
  const prereqs: string[] = [];
  const heads: Array<{ sha: string; ref: string }> = [];
  for (const l of lines.slice(1)) {
    if (l.startsWith("@")) continue; // v3 capabilities
    if (l.startsWith("-")) {
      const id = l.slice(1).split(" ")[0] ?? "";
      if (!SHA.test(id)) return null;
      prereqs.push(id);
      continue;
    }
    const [id, ref] = l.split(" ");
    if (!id || !ref || !SHA.test(id) || !/^(?:HEAD|refs\/[A-Za-z0-9._/-]{1,200})$/.test(ref)) return null;
    heads.push({ sha: id, ref });
  }
  return heads.length ? { prereqs, heads } : null;
}

/** Whether a commit is on a branch or a tag of the clone (published work), never only on another ref. */
async function published(clone: string, sha: string, env: Record<string, string>, signal?: AbortSignal): Promise<boolean> {
  const r = await git(["for-each-ref", "--count=1", "--format=%(refname)", `--contains=${sha}`, "refs/heads/", "refs/tags/"], clone, env, { signal });
  return r.code === 0 && r.out !== "";
}

/**
 * A bare mirror of the clone's PUBLISHED history only (its branches and tags, fetched over git's transport, so upload-
 * pack sends nothing a stash, remote-tracking or dangling ref alone reaches), kept under `root` and brought up to date
 * incrementally before each use. What a delta bundle may borrow (FO-2 r3 MED 1).
 */
async function publishedMirror(clone: string, root: string, env: Record<string, string>, signal?: AbortSignal): Promise<string> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, `${createHash("sha256").update(clone).digest("hex").slice(0, 24)}.git`);
  if (!existsSync(join(dir, "HEAD"))) {
    const init = await git(["init", "--quiet", "--bare", "--template=", dir], root, env, { signal });
    if (init.code !== 0) throw new Error("the published-history mirror could not be made");
  }
  const f = await git(["fetch", "--quiet", "--prune", "--no-write-fetch-head", "--", clone, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], dir, env, { signal, timeoutMs: 900_000 });
  if (f.code !== 0) throw new Error("the published-history mirror could not be brought up to date");
  return dir;
}

/**
 * Admits a workspace delta bundle into the clone (FO-2 r2 MED 1, r3 MED 1). The bundle is first fetched into a
 * scratch repository whose ONLY borrowed objects are the clone's published history (publishedMirror): git's own
 * connectivity check then proves that every object the bundle's heads reach, commits, trees and blobs alike, either
 * came in the bundle's own pack or is published — thin-pack delta bases included (they resolve only against published
 * objects). A bundle that points at a stash's tree, commit or blob of the clone fails there. Only then is it fetched
 * into the clone under `refs/walkie/in/<tag>/…`. Every failure reads the same (no object's existence shows through).
 */
async function admitDelta(
  clone: string, repo: string, delta: string, tag: string, env: Record<string, string>, signal?: AbortSignal, mirrors?: string,
): Promise<Array<{ sha: string; ref: string }>> {
  const hdr = bundleHeader(delta);
  const refuse = (): never => {
    const ids = (hdr?.prereqs ?? []).slice(0, 3).map((m) => m.slice(0, 12));
    throw new SeatRefusal(`the workspace delta bundle doesn't apply to repo ${repo}'s branches and tags on this machine${ids.length ? ` (it builds on ${ids.join(", ")})` : ""}: send one based on a commit this machine's branches have`);
  };
  if (!hdr) return refuse();
  for (const p of hdr.prereqs) if (!(await published(clone, p, env, signal))) refuse();
  const scratch = mkdtempSync(join(dirname(delta), "admit-"));
  try {
    const mirror = await publishedMirror(clone, mirrors ?? join(scratch, "mirrors"), env, signal);
    const bare = join(scratch, "q.git");
    if ((await git(["init", "--quiet", "--bare", "--template=", bare], scratch, env, { signal })).code !== 0) refuse();
    mkdirSync(join(bare, "objects", "info"), { recursive: true });
    writeFileSync(join(bare, "objects", "info", "alternates"), `${join(mirror, "objects")}\n`);
    const specs = hdr.heads.map((h, i) => `+${h.ref}:refs/in/${i}`);
    // The fetch's connectivity check fails on any object neither in the bundle nor published.
    if ((await git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", delta, ...specs], bare, env, { signal })).code !== 0) refuse();
    const full = await git(["rev-list", "--objects", "--quiet", ...hdr.heads.map((_, i) => `refs/in/${i}`)], bare, env, { signal, timeoutMs: 900_000 });
    if (full.code !== 0) refuse(); // belt and braces: every object reachable from the heads is readable here
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const specs = hdr.heads.map((h, i) => `+${h.ref}:refs/walkie/in/${tag}/${i}`);
  const f = await git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", delta, ...specs], clone, env, { signal });
  if (f.code !== 0) refuse();
  return hdr.heads;
}

export interface ResolvedRepo {
  /** The host's clone (an absolute path from config.json `fleet.repos`). */
  clone: string;
  /** The exact commit the seat starts from. */
  sha: string;
}

/**
 * The host's clone for `ws.repo` with `ws.bundle` (a delta bundle file) fetched into it, and `ws.ref` resolved to a
 * commit. A delta bundle whose prerequisite commits the clone lacks is refused with the reason.
 */
export async function resolveRepo(
  repos: Readonly<Record<string, string>>, ws: SeatWorkspace, delta: string | null, tag: string, env: Record<string, string>, signal?: AbortSignal,
  /** Where published-history mirrors are kept (the daemon's `seats-mirror`); default: a throwaway one per call. */
  mirrors?: string,
): Promise<ResolvedRepo> {
  const clone = repos[ws.repo];
  if (!clone) throw new SeatRefusal(`this machine has no clone of repo ${ws.repo} (its person or an admin agent adds one: walkie seats repo add ${ws.repo} <path>)`);
  const top = await git(["rev-parse", "--is-inside-work-tree"], clone, env, { signal }).catch(() => null);
  if (!top || top.code !== 0) throw new SeatRefusal(`repo ${ws.repo} on this machine isn't a git work tree`);
  let heads: Array<{ sha: string; ref: string }> = [];
  if (delta) heads = await admitDelta(clone, ws.repo, delta, tag, env, signal, mirrors);
  const sha = await resolveRef(clone, ws.ref, heads, tag, env, signal);
  if (!sha) {
    throw new SeatRefusal(`ref ${ws.ref} isn't a branch, a tag, or a commit on one, in repo ${ws.repo} on this machine${delta ? " (nor in the delta bundle)" : ""}`
      + " (stashes, remote-tracking and other refs are never served)");
  }
  return { clone, sha };
}

/**
 * `ref` as one commit, only from what the person's clone publishes as work (FO-2 r1 MEDIUM 6): a branch or a tag
 * (`refs/heads/…`, `refs/tags/…`, or a short name looked up there explicitly, never git's other DWIM places such as
 * `stash` or `refs/remotes/…`), the delta bundle's heads, or a commit id reachable from one of those. Null otherwise.
 */
async function resolveRef(
  clone: string, ref: string, heads: ReadonlyArray<{ sha: string; ref: string }>, tag: string, env: Record<string, string>, signal?: AbortSignal,
): Promise<string | null> {
  const commit = async (full: string): Promise<string | null> => {
    const r = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${full}^{commit}`], clone, env, { signal });
    return r.code === 0 && SHA.test(r.out) ? r.out : null;
  };
  let sha: string | null = null;
  const inBundle = heads.find((h) => h.ref === ref || h.ref === `refs/heads/${ref}` || h.ref === `refs/tags/${ref}`);
  if (SHA.test(ref)) sha = await commit(ref);
  else if (inBundle) sha = await commit(inBundle.sha);
  else if (ref.startsWith("refs/")) sha = ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/") ? await commit(ref) : null;
  else sha = (await commit(`refs/heads/${ref}`)) ?? (await commit(`refs/tags/${ref}`));
  if (!sha) return null;
  // Reachable from a branch, a tag or this seat's own delta refs: nothing else of the clone's history is served.
  const r = await git(["for-each-ref", "--count=1", "--format=%(refname)", `--contains=${sha}`, "refs/heads/", "refs/tags/", `refs/walkie/in/${tag}/`], clone, env, { signal });
  return r.code === 0 && r.out ? sha : null;
}

/** Removes the delta bundle's private refs from the clone (the seat's worktree or bundle holds what it needs). */
export async function dropInRefs(clone: string, tag: string, env: Record<string, string>): Promise<void> {
  const r = await git(["for-each-ref", "--format=%(refname)", `refs/walkie/in/${tag}/`], clone, env);
  for (const ref of r.out.split("\n").filter((x) => x.startsWith(`refs/walkie/in/${tag}/`))) {
    await git(["update-ref", "-d", ref], clone, env);
  }
}

export interface Worktree {
  /** The seat's working directory. */
  cwd: string;
  /** Its own git directory and the common one, as the host made them (the seat's `.git` file is never trusted). */
  dirs: { gitDir: string; commonDir: string };
  /** A build's branch (`lane/<label>`, or `-<n>` after it when that one can't safely be reused). */
  branch?: string;
}

/** The marker Walkie writes into the admin directory of each worktree it makes (`<common>/worktrees/<name>/`). */
export const LANE_MARKER = "walkie-seat-lane";
/** Walkie's record of the lane branches it created: `refs/walkie/lanes/<branch>` → the tip it last set. */
const LANES_REF = "refs/walkie/lanes/";
/** Suffixes tried for a lane branch that can't be reused safely (`lane/x-2` … `lane/x-20`). */
const MAX_BRANCH_TRIES = 20;

/**
 * A same-user seat's workspace in the host's clone: `<clone>/.worktrees/<label>`, on a Walkie lane branch for a
 * build, detached at `sha` for an audit (FO-2 r1 HIGH 1/2/8):
 * - `.worktrees` and the label's path must be real directories inside the clone (no symlink on the way);
 * - an existing `.worktrees/<label>` is replaced only when it is a worktree Walkie made (its marker) and clean;
 *   anything else there is refused;
 * - a branch is created (never `-B`), or reused only when Walkie created it (its ownership ref) and moving it to
 *   `sha` is a fast-forward; otherwise the next free `-<n>` suffix. A branch of that name Walkie didn't create is
 *   refused.
 */
export async function addWorktree(
  clone: string, label: string, mode: "branch" | "detached", sha: string, branch: string | undefined, env: Record<string, string>, signal?: AbortSignal,
): Promise<Worktree> {
  const real = realpathSync(clone);
  const common = await commonDirOf(real, env, signal);
  const root = join(real, ".worktrees");
  if (existsSync(root) || isLink(root)) {
    const st = lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new SeatRefusal(".worktrees in this machine's clone isn't a plain directory (a symlink?): refused");
  } else {
    mkdirSync(root, { mode: 0o755 });
  }
  if (realpathSync(root) !== root) throw new SeatRefusal(".worktrees in this machine's clone resolves outside it: refused");
  const path = join(root, label);
  const cfg = await safeFilters(real, env, signal);
  const replacing = existsSync(path) || isLink(path);
  if (!replacing) {
    // A record of a worktree at this path whose directory is gone: Walkie's own is dropped (never `worktree prune`,
    // which would drop the person's other missing worktrees too); anyone else's is refused.
    const stale = adminDirOf(common, path);
    if (stale) {
      if (!existsSync(join(stale, LANE_MARKER))) throw new SeatRefusal(`.worktrees/${label} is registered in this machine's clone as a worktree Walkie didn't make: refused`);
      rmSync(stale, { recursive: true, force: true });
    }
  } else {
    // Checked first, removed last (FO-2 r2 LOW): a refusal below leaves the previous worktree where it was.
    if (isLink(path)) throw new SeatRefusal(`.worktrees/${label} is a symlink: refused`);
    const admin = adminDirOf(common, path);
    if (!admin || !existsSync(join(admin, LANE_MARKER))) {
      throw new SeatRefusal(`.worktrees/${label} in this machine's clone isn't a worktree Walkie made: it is left alone (move it, or use another label)`);
    }
    // Clean, ignored files included (they would be deleted with it: FO-2 r2 LOW).
    const st = await git(["status", "--porcelain", "--ignored", "--untracked-files=all"], path, env, { signal, config: cfg });
    if (st.code !== 0 || st.out) {
      const ignored = st.out.split("\n").filter((l) => l.startsWith("!!")).length;
      throw new SeatRefusal(`.worktrees/${label} already exists in this machine's clone with ${ignored && ignored === st.out.split("\n").length ? "ignored files" : "uncommitted work"}: finish or remove it first`);
    }
  }
  await excludeFromGit(real, "/.worktrees/", env, signal, WORKTREES_MARK);
  // The branch is chosen (nothing changes yet), then the old worktree goes (no --force: git refuses a tree that got
  // dirty since the check, FO-2 r3 LOW 4), then the branch and Walkie's record of it move together.
  const plan = mode === "branch" ? await chooseLane(real, branch ?? `lane/${label}`, sha, replacing ? path : null, env, signal) : undefined;
  if (replacing) {
    const rm = await git(["worktree", "remove", path], real, env, { signal, config: cfg });
    if (rm.code !== 0) throw new SeatRefusal(`.worktrees/${label} could not be replaced (${/modified|untracked|dirty/i.test(rm.err) ? "it has uncommitted work" : "git refused"}): finish or remove it first`);
  }
  const lane = plan ? await applyLane(real, plan, sha, env, signal) : undefined;
  const args = lane ? ["worktree", "add", "--quiet", path, lane] : ["worktree", "add", "--quiet", "--detach", path, sha];
  const add = await git(args, real, env, { signal, config: cfg });
  if (add.code !== 0) throw new SeatRefusal(`the worktree could not be made: ${redactSecrets(add.err).text.split("\n")[0]?.slice(0, 200) ?? "git failed"}`);
  const admin = adminDirOf(common, path);
  if (!admin) throw new Error("the new worktree's admin directory could not be found");
  writeFileSync(join(admin, LANE_MARKER), `walkie seat lane ${label}\n`, { mode: 0o600 });
  return { cwd: path, dirs: { gitDir: admin, commonDir: common }, ...(lane ? { branch: lane } : {}) };
}

/** filterOverrides, a failure of it being a refusal (nothing is checked out with a filter left on). */
async function safeFilters(repo: string, env: Record<string, string>, signal?: AbortSignal): Promise<string[]> {
  try { return await filterOverrides(repo, env, signal); } catch (err) {
    if (err instanceof GitConfigError) throw new SeatRefusal(err.message);
    throw err;
  }
}

/** The clone's common git directory (absolute). */
async function commonDirOf(clone: string, env: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const cd = await git(["rev-parse", "--git-common-dir"], clone, env, { signal });
  if (cd.code !== 0 || !cd.out) throw new Error("the clone's git directory could not be read");
  return realpathSync(isAbsolute(cd.out) ? cd.out : resolve(clone, cd.out));
}

/** The admin directory (`<common>/worktrees/<name>`) whose `gitdir` points at `<path>/.git`, from the clone's own records. */
function adminDirOf(common: string, path: string): string | null {
  const dir = join(common, "worktrees");
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return null; }
  for (const n of names) {
    try {
      const target = readFileSync(join(dir, n, "gitdir"), "utf8").trim();
      if (resolve(target) === join(path, ".git")) return join(dir, n);
    } catch { /* not a worktree record */ }
  }
  return null;
}

/** What chooseLane decided: create the branch, move it from `tip` (checked again when applied), or use it as it is. */
interface LanePlan { name: string; action: "create" | "move" | "keep"; tip: string | null; staleRecord: boolean }

/**
 * The lane branch a build gets (FO-2 r1 HIGH 1, r2 LOW), decided without changing anything: `want` created at `sha`,
 * or reused when it is Walkie's — its ownership record names exactly its tip (a branch the person moved or re-made is
 * theirs) — no other worktree has it checked out, and moving it loses nothing: a fast-forward, or its commits are
 * already on one of the person's branches (merged). Otherwise `want-2`, `want-3`… A `want` Walkie doesn't own is
 * refused; a suffixed name it doesn't own is skipped.
 */
async function chooseLane(clone: string, want: string, sha: string, replacing: string | null, env: Record<string, string>, signal?: AbortSignal): Promise<LanePlan> {
  const list = await git(["worktree", "list", "--porcelain"], clone, env, { signal });
  const checkedOut = new Set<string>();
  let at = "";
  for (const l of list.out.split("\n")) {
    if (l.startsWith("worktree ")) at = l.slice("worktree ".length);
    else if (l.startsWith("branch ") && (!replacing || resolve(at) !== replacing)) checkedOut.add(l.slice("branch ".length));
  }
  const rev = async (ref: string): Promise<string | null> => {
    const r = await git(["rev-parse", "--verify", "--quiet", ref], clone, env, { signal });
    return r.code === 0 && SHA.test(r.out) ? r.out : null;
  };
  for (let i = 1; i <= MAX_BRANCH_TRIES; i++) {
    const name = i === 1 ? want : `${want}-${i}`;
    const tip = await rev(`refs/heads/${name}`);
    const record = await rev(`${LANES_REF}${name}`);
    if (!tip) return { name, action: "create", tip: null, staleRecord: record !== null };
    if (record !== tip) {
      if (i === 1) throw new SeatRefusal(`branch ${name} exists in this machine's clone and isn't Walkie's (Walkie didn't create it, or someone moved it since): it is left alone (use another label)`);
      continue;
    }
    if (checkedOut.has(`refs/heads/${name}`)) continue;
    if (tip === sha) return { name, action: "keep", tip, staleRecord: false };
    const ff = (await git(["merge-base", "--is-ancestor", tip, sha], clone, env, { signal })).code === 0;
    if (ff || (await mergedElsewhere(clone, tip, env, signal))) return { name, action: "move", tip, staleRecord: false };
  }
  throw new SeatRefusal(`every lane branch ${want}, ${want}-2 … ${want}-${MAX_BRANCH_TRIES} holds commits that aren't merged anywhere, or isn't Walkie's: merge or delete some (git branch -D ${want}-<n>) and retry`);
}

/**
 * Applies a LanePlan: the branch and Walkie's ownership record change in ONE ref transaction (FO-2 r3 LOW 2: never a
 * moved branch without its record), each conditioned on what chooseLane saw. Refused if either changed meanwhile.
 */
async function applyLane(clone: string, plan: LanePlan, sha: string, env: Record<string, string>, signal?: AbortSignal): Promise<string> {
  if (plan.action === "keep") return plan.name;
  const branch = `refs/heads/${plan.name}`;
  const record = `${LANES_REF}${plan.name}`;
  const input = plan.action === "create"
    ? `start\ncreate ${branch} ${sha}\n${plan.staleRecord ? `update ${record} ${sha}` : `create ${record} ${sha}`}\nprepare\ncommit\n`
    : `start\nupdate ${branch} ${sha} ${plan.tip}\nupdate ${record} ${sha} ${plan.tip}\nprepare\ncommit\n`;
  const r = await git(["update-ref", "--stdin"], clone, env, { signal, input });
  if (r.code !== 0) throw new SeatRefusal(`branch ${plan.name} changed while the seat was being prepared: retry`);
  return plan.name;
}

/** A lane tip whose commits are already on a branch of the person's (not a lane): moving the lane loses nothing. */
async function mergedElsewhere(clone: string, tip: string, env: Record<string, string>, signal?: AbortSignal): Promise<boolean> {
  const r = await git(["for-each-ref", "--format=%(refname)", `--contains=${tip}`, "refs/heads/"], clone, env, { signal });
  return r.code === 0 && r.out.split("\n").some((ref) => ref && !ref.startsWith("refs/heads/lane/") && !ref.startsWith("refs/heads/walkie/"));
}

/**
 * After a seat on a lane branch ends (FO-2 r3 LOW 3): Walkie's ownership record follows the branch to the seat's own
 * result — only when the branch's tip is exactly the commit the seat's outcome saw (`seatHead`) and the record is
 * still where Walkie set it (`base`), in one conditioned update. Anything else (the person committed there since) is
 * left unclaimed: the lane is then the person's. With the branch gone, the record goes.
 */
export async function recordLaneTip(clone: string, branch: string, env: Record<string, string>, seat?: { base: string; head: string }): Promise<void> {
  const tip = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], clone, env);
  if (tip.code !== 0 || !SHA.test(tip.out)) { await git(["update-ref", "-d", `${LANES_REF}${branch}`], clone, env); return; }
  if (!seat || tip.out !== seat.head || seat.head === seat.base) return;
  const ahead = await git(["merge-base", "--is-ancestor", seat.base, seat.head], clone, env);
  if (ahead.code !== 0) return;
  await git(["update-ref", `${LANES_REF}${branch}`, seat.head, seat.base], clone, env); // only from where Walkie set it
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/**
 * A standalone copy of the clone at `sha` in `<seat dir>/repo` (mode `fresh`): `git clone --no-local` (no
 * hardlinks into the person's clone), then the commit fetched through a temporary ref and checked out detached.
 */
export async function freshClone(clone: string, sha: string, seatDir: string, tag: string, env: Record<string, string>, signal?: AbortSignal): Promise<{ cwd: string }> {
  const repo = join(seatDir, "repo");
  const ref = `refs/walkie/seat/${tag}`;
  const set = await git(["update-ref", ref, sha], clone, env, { signal });
  if (set.code !== 0) throw new Error("the seat's commit could not be marked in the clone");
  try {
    const c = await git(["clone", "--quiet", "--no-local", "--no-checkout", "--no-tags", clone, repo], seatDir, env, { signal, timeoutMs: 600_000 });
    if (c.code !== 0) throw new Error("git clone --no-local of this machine's clone failed");
    const f = await git(["fetch", "--quiet", "--no-tags", "origin", ref], repo, env, { signal, timeoutMs: 600_000 });
    if (f.code !== 0) throw new Error("the seat's commit could not be fetched into its copy");
    const co = await git(["checkout", "--quiet", "--detach", sha], repo, env, { signal, config: await safeFilters(repo, env, signal) });
    if (co.code !== 0) throw new Error("the seat's commit could not be checked out");
    return { cwd: repo };
  } finally {
    await git(["update-ref", "-d", ref], clone, env);
  }
}

/** Where the host stages seat users' bundles: `<walkie home>/seats-stage` (0700; swept at every start). */
export function stageDir(walkieHome: string): string {
  const dir = join(walkieHome, "seats-stage");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} isn't a directory of Walkie's`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700); // an existing one is tightened too (FO-2 r2 LOW)
  return dir;
}

/** Removes every staged bundle a previous run of the daemon left behind (a crash between staging and the seat's end). */
export function sweepStaged(walkieHome: string): number {
  const dir = join(walkieHome, "seats-stage");
  let n = 0;
  try {
    for (const f of readdirSync(dir)) { rmSync(join(dir, f), { force: true, recursive: true }); n++; }
  } catch { /* none */ }
  return n;
}

/**
 * A bundle of `sha` (its HEAD, detached) made from the clone's objects through a scratch git directory, for a seat
 * user (who can't read the person's home). Private (FO-2 r1 HIGH 3): written 0600 in the daemon's own 0700 staging
 * directory and streamed to the seat's runner over its stdin; never a path another local user could open. Over
 * `maxBytes` it is refused.
 */
export async function stageBundle(clone: string, sha: string, into: string, name: string, maxBytes: number, env: Record<string, string>, signal?: AbortSignal): Promise<{ path: string; size: number }> {
  const objects = join(await commonDirOf(clone, env, signal), "objects");
  const scratch = mkdtempSync(join(into, "scratch-"));
  const out = join(into, name);
  try {
    const bare = join(scratch, "s.git");
    const init = await git(["init", "--quiet", "--bare", "--template=", bare], scratch, env, { signal });
    if (init.code !== 0) throw new Error("git init failed");
    mkdirSync(join(bare, "objects", "info"), { recursive: true });
    writeFileSync(join(bare, "objects", "info", "alternates"), `${objects}\n`);
    writeFileSync(join(bare, "HEAD"), `${sha}\n`);
    // Streamed to a 0600 file and stopped at the cap: the staging directory never holds more than `maxBytes` of it.
    const made = await gitToFile(["bundle", "create", "--quiet", "-", "HEAD"], bare, env, out, maxBytes, { signal, timeoutMs: 900_000 });
    if (made.capped) throw new SeatRefusal(`the repo at that commit bundles to more than ${Math.round(maxBytes / 1024 / 1024)} MB, the most a seat user can receive`);
    if (made.code !== 0 || !made.size) throw new Error("the seat's repo bundle could not be made");
    return { path: out, size: made.size };
  } catch (err) {
    rmSync(out, { force: true });
    throw err;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
