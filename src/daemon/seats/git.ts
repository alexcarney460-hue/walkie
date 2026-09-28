// Git for seats (PROTOCOL §11): clone the launcher's bundle into the seat's directory, and bundle what the seat
// committed on top of it. Arguments are passed as argv, never through a shell.
//
// Every git call here runs with no system or global config (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null), with
// the program-running settings the command line can override turned off (SAFE: hooks, fsmonitor, external diff,
// sshCommand, credential helpers, askpass, pager; submodule recursion; the `ext::` transport), no in-tree attributes
// where git supports `attr.tree` (2.42+), and GIT_LFS_SKIP_SMUDGE. What that does NOT cover by itself: a repository's
// OWN config (.git/config) is read by a call that runs in it. Two cases:
// - a seat's repository after the seat ended: never run in at all (seatOutcome inspects its objects, HEAD and index
//   through a scratch git directory of the host's), so nothing a seat planted there (hooks, fsmonitor, filter/diff/
//   merge drivers, sshCommand, credential helpers, include/includeIf) runs;
// - the host person's own clone (v2 workspaces, FO-2): its config is the person's; every filter driver it defines is
//   neutralized per call (filterOverrides: empty smudge/clean/process, not required) before a checkout.
// Each call leads its own process group, killed as a whole when git exits, times out or the seat is stopped.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface GitResult { code: number; out: string; err: string }

/** Git's empty tree (sha1): as `attr.tree`, no attributes from the repository's tree. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Command-line settings for every call (they outrank any file): belt and braces over the isolated config. */
const SAFE = [
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.sshCommand=false",
  "-c", "core.attributesFile=/dev/null", "-c", "credential.helper=", "-c", "core.askPass=", "-c", "core.pager=cat",
  "-c", "submodule.recurse=false", "-c", "protocol.ext.allow=never",
  // No in-tree .gitattributes (git 2.42+; older git ignores the key): no filter, LFS or ident attribute applies.
  "-c", `attr.tree=${EMPTY_TREE}`,
];

/** The environment of every call: no system/global config or attributes, no prompts, no optional index writes. */
function gitEnv(env: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? "/", LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/echo", GIT_NO_REPLACE_OBJECTS: "1", GIT_LFS_SKIP_SMUDGE: "1", ...extra,
  };
}

export interface GitOptions {
  /** Default 120 s. */
  timeoutMs?: number;
  /** Aborting kills the call's whole process group (a stop, a revoke, the daemon's shutdown). */
  signal?: AbortSignal;
  /** Extra variables (GIT_DIR and the like). */
  env?: Record<string, string>;
  /** Extra `-c` settings after SAFE (filterOverrides for a clone whose config defines filters). */
  config?: string[];
  /** Text written to git's stdin (then closed); default none. */
  input?: string;
}

/**
 * `-c` settings that disable every filter driver a repository's own config defines (`filter.<name>.*`): empty smudge,
 * clean and process commands, not required. For calls that check files out in the host person's clone (FO-2).
 */
export async function filterOverrides(repo: string, env: Record<string, string>, signal?: AbortSignal): Promise<string[]> {
  const r = await git(["config", "--name-only", "--get-regexp", "^filter\\."], repo, env, { signal });
  // Exit 1 = no such key; anything else: the config couldn't be read, so nothing is checked out (fail closed).
  if (r.code !== 0 && r.code !== 1) throw new GitConfigError("the clone's git config couldn't be read to turn its filters off");
  const names = new Set(r.code === 0 ? r.out.split("\n").map((k) => /^filter\.(.+)\.[^.]+$/.exec(k.trim())?.[1]).filter((n): n is string => !!n) : []);
  if (names.size > MAX_FILTERS) throw new GitConfigError(`the clone's config defines ${names.size} filter drivers (over ${MAX_FILTERS}): refused rather than checked out with some left on`);
  return [...names].flatMap((n) => ["-c", `filter.${n}.smudge=`, "-c", `filter.${n}.clean=`, "-c", `filter.${n}.process=`, "-c", `filter.${n}.required=false`]);
}

/** A clone whose filters can't all be turned off (filterOverrides). */
export class GitConfigError extends Error {}
/** More filter drivers than this in one clone's config is refused (each needs four `-c` arguments). */
export const MAX_FILTERS = 256;

/**
 * `git … -` whose stdout goes to `out` (created 0600, never overwritten) as it streams, stopped (its process group
 * killed, the file removed) the moment it passes `maxBytes`: a staged bundle can't fill the disk first (FO-2 r2 MED 5).
 */
export async function gitToFile(
  args: string[], cwd: string, env: Record<string, string>, out: string, maxBytes: number, opts: GitOptions = {},
): Promise<{ code: number; size: number; capped: boolean; err: string }> {
  const { closeSync, openSync, writeSync } = await import("node:fs");
  if (opts.signal?.aborted) return { code: -1, size: 0, capped: false, err: "stopped" };
  const fd = openSync(out, "wx", 0o600);
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["git", ...SAFE, ...(opts.config ?? []), ...args], {
      cwd, env: gitEnv(env, opts.env), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    });
  } catch (err) {
    closeSync(fd); // a failed spawn leaks no descriptor (FO-2 r3 LOW 5)
    throw err;
  }
  const kill = () => killGroup(p.pid);
  const timer = setTimeout(kill, opts.timeoutMs ?? 120_000);
  opts.signal?.addEventListener("abort", kill, { once: true });
  let size = 0;
  let capped = false;
  try {
    const errText = new Response(p.stderr as ReadableStream<Uint8Array>).text();
    const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      if (size + r.value.byteLength > maxBytes) { capped = true; kill(); break; }
      let off = 0;
      while (off < r.value.byteLength) off += writeSync(fd, r.value, off, r.value.byteLength - off);
      size += r.value.byteLength;
    }
    const code = await p.exited;
    const err = (await errText).trim();
    return { code: capped || opts.signal?.aborted ? -1 : code, size, capped, err };
  } finally {
    closeSync(fd);
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", kill);
    kill();
    if (capped) { const { rmSync } = await import("node:fs"); rmSync(out, { force: true }); }
  }
}

function killGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { /* the group is gone */ }
}

/** Runs git in its own process group with a bounded time; never throws for a non-zero exit (-1: aborted). */
export async function git(args: string[], cwd: string, env: Record<string, string>, opts: GitOptions = {}): Promise<GitResult> {
  if (opts.signal?.aborted) return { code: -1, out: "", err: "stopped" };
  const p = Bun.spawn(["git", ...SAFE, ...(opts.config ?? []), ...args], {
    cwd, env: gitEnv(env, opts.env), stdin: opts.input !== undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", detached: true,
  });
  if (opts.input !== undefined) {
    const sink = p.stdin as import("bun").FileSink;
    sink.write(opts.input);
    void sink.end();
  }
  const kill = () => killGroup(p.pid);
  const timer = setTimeout(kill, opts.timeoutMs ?? 120_000);
  opts.signal?.addEventListener("abort", kill, { once: true });
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code: opts.signal?.aborted ? -1 : code, out: out.trim(), err: err.trim() };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", kill);
    kill(); // whatever git started and left behind in its group
  }
}

/** Clones `bundle` into `<parent>/repo` and returns the repo path and its HEAD (the base the seat starts from). */
export async function cloneBundle(bundle: string, parent: string, env: Record<string, string>, signal?: AbortSignal): Promise<{ repo: string; base: string }> {
  const repo = join(parent, "repo");
  const heads = await git(["bundle", "list-heads", bundle], parent, env, { signal });
  if (heads.code !== 0 || !heads.out) throw new Error(signal?.aborted ? "stopped" : "the repo bundle is not a valid git bundle");
  const clone = await git(["clone", "--quiet", "--no-hardlinks", bundle, repo], parent, env, { signal });
  if (clone.code !== 0) throw new Error(signal?.aborted ? "stopped" : "git clone of the repo bundle failed (a bundle needs a HEAD: git bundle create f HEAD <branch>)");
  const head = await git(["rev-parse", "HEAD"], repo, env, { signal });
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(head.out)) throw new Error("the repo bundle has no HEAD commit");
  return { repo, base: head.out };
}

export interface SeatGitOutcome {
  commits: number;
  dirty: number;
  /** A commit touches the seat's brief file: no bundle is returned (FO-2). */
  brief?: true;
  /** The bundle file with the new commits (base..HEAD, or all of HEAD without a base). */
  bundle?: string;
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REF_NAME = /^refs\/[A-Za-z0-9._/-]{1,200}$/;

/** A small regular file inside `dir` (never a symlink), or null. */
function smallFile(dir: string, name: string): string | null {
  const p = join(dir, name);
  if (!resolve(p).startsWith(resolve(dir) + "/")) return null;
  try {
    const st = lstatSync(p);
    return st.isFile() && st.size <= 1024 * 1024 ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * The object id HEAD points at, read from the files (loose refs, packed-refs) without running git there. `refsDir`:
 * where the refs live when HEAD is a linked worktree's (its common git directory; FO-2).
 */
export function readHead(gitDir: string, refsDir: string = gitDir): string | null {
  let target = "HEAD";
  for (let depth = 0; depth < 5; depth++) {
    if (target !== "HEAD" && (!REF_NAME.test(target) || target.split("/").some((s) => s === ".." || s === "." || s === ""))) return null;
    let value = smallFile(target === "HEAD" ? gitDir : refsDir, target)?.trim() ?? null;
    if (value === null && target !== "HEAD") {
      for (const line of (smallFile(refsDir, "packed-refs") ?? "").split("\n")) {
        const [id, name] = line.trim().split(" ");
        if (name === target && id && OBJECT_ID.test(id)) { value = id; break; }
      }
    }
    if (!value) return null;
    if (OBJECT_ID.test(value)) return value;
    const m = /^ref: (\S+)$/.exec(value);
    if (!m) return null;
    target = m[1] as string;
  }
  return null;
}

/**
 * What the seat left in `repo`: new commits (bundled) and uncommitted files. Null when `repo` isn't a plain git work
 * tree. The seat's `.git` is treated as data: its HEAD is read from the files, and git runs in a scratch git
 * directory of the host's whose objects borrow the seat's (alternates) and whose index is a copy of the seat's, over
 * the seat's work tree; the seat's config, hooks and info/attributes are never read.
 */
export async function seatOutcome(
  repo: string, base: string | null, out: string, env: Record<string, string>, signal?: AbortSignal, scratchRoot: string = tmpdir(),
  /** A linked worktree (FO-2): its own git directory (HEAD, index) and the common one (objects, refs), as the host made them. */
  dirs?: { gitDir: string; commonDir: string },
  /** The brief's path in the tree (FO-2): commits that touch it are never bundled. */
  forbid?: string,
): Promise<SeatGitOutcome | null> {
  const gitDir = dirs?.gitDir ?? join(repo, ".git");
  const commonDir = dirs?.commonDir ?? gitDir;
  try {
    if (!lstatSync(gitDir).isDirectory() || !statSync(join(commonDir, "objects")).isDirectory()) return null;
  } catch {
    return null;
  }
  const scratch = mkdtempSync(join(scratchRoot, "walkie-seat-git-"));
  try {
    const inspect = join(scratch, "inspect.git");
    const init = await git(["init", "--quiet", "--bare", "--template=", inspect], scratch, env, { signal });
    if (init.code !== 0) return null;
    mkdirSync(join(inspect, "objects", "info"), { recursive: true });
    writeFileSync(join(inspect, "objects", "info", "alternates"), `${resolve(commonDir, "objects")}\n`);
    if (existsSync(join(gitDir, "index"))) {
      try { if (lstatSync(join(gitDir, "index")).isFile()) copyFileSync(join(gitDir, "index"), join(inspect, "index")); } catch { /* no index: all untracked */ }
    }
    const head = readHead(gitDir, commonDir);
    if (head) writeFileSync(join(inspect, "HEAD"), `${head}\n`);
    const at = { signal, env: { GIT_DIR: inspect, GIT_WORK_TREE: repo } };
    // Untracked files are counted without running content filters (none are configured here anyway).
    const status = await git(["-c", "core.bare=false", "status", "--porcelain", "--ignore-submodules=all"], repo, env, at);
    const dirty = status.code === 0 && status.out ? status.out.split("\n").filter(Boolean).length : 0;
    if (!head) return { commits: 0, dirty };
    const range = base ? [`${base}..HEAD`] : ["HEAD"];
    const count = await git(["rev-list", "--count", ...range], repo, env, at);
    const commits = count.code === 0 ? Number(count.out) || 0 : 0;
    if (!commits) return { commits: 0, dirty };
    if (forbid && !(await briefFree(repo, range, forbid, env, at))) return { commits, dirty, brief: true };
    const made = await git(["bundle", "create", out, "HEAD", ...(base ? [`^${base}`] : [])], repo, env, at);
    if (made.code !== 0 || !existsSync(out) || !statSync(out).size) return { commits, dirty };
    return { commits, dirty, bundle: out };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * No outgoing commit (every one in `range`, merges and their side history included: no path limiting, so no history
 * simplification) has `path` in its tree (FO-2 r2 MED 3). One `cat-file --batch-check` for all of them; false when it
 * can't be told (fail closed).
 */
async function briefFree(repo: string, range: string[], path: string, env: Record<string, string>, at: GitOptions): Promise<boolean> {
  const list = await git(["rev-list", ...range], repo, env, at);
  if (list.code !== 0) return false;
  const commits = list.out.split("\n").filter((c) => /^[0-9a-f]{40,64}$/.test(c));
  if (!commits.length) return true;
  const check = await git(["cat-file", "--batch-check"], repo, env, { ...at, input: commits.map((c) => `${c}:${path}\n`).join("") });
  if (check.code !== 0) return false;
  const lines = check.out.split("\n");
  return lines.length === commits.length && lines.every((l) => l.endsWith(" missing"));
}

export function readFile(path: string): Uint8Array { return new Uint8Array(readFileSync(path)); }
