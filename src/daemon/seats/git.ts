// Git for seats (PROTOCOL §11): clone the launcher's bundle into the seat's directory, and bundle what the seat
// committed on top of it. Arguments are passed as argv, never through a shell.
//
// Every git call here runs as the host's own tool, never under the seat's configuration: no system or global config
// (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null), and after the seat ended its repository's own config is never
// read at all (seatOutcome inspects the seat's objects, HEAD and index through a scratch git directory of the host's).
// So nothing a seat planted there (hooks, core.fsmonitor, filter/diff/merge drivers, core.sshCommand, credential
// helpers, include/includeIf) can run a program. Each call leads its own process group, killed as a whole when git
// exits, times out or the seat is stopped.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface GitResult { code: number; out: string; err: string }

/** Command-line settings for every call (they outrank any file): belt and braces over the isolated config. */
const SAFE = [
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.sshCommand=false",
  "-c", "core.attributesFile=/dev/null", "-c", "credential.helper=", "-c", "core.askPass=", "-c", "core.pager=cat",
];

/** The environment of every call: no system/global config or attributes, no prompts, no optional index writes. */
function gitEnv(env: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? "/", LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/echo", GIT_NO_REPLACE_OBJECTS: "1", ...extra,
  };
}

export interface GitOptions {
  /** Default 120 s. */
  timeoutMs?: number;
  /** Aborting kills the call's whole process group (a stop, a revoke, the daemon's shutdown). */
  signal?: AbortSignal;
  /** Extra variables (GIT_DIR and the like). */
  env?: Record<string, string>;
}

function killGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { /* the group is gone */ }
}

/** Runs git in its own process group with a bounded time; never throws for a non-zero exit (-1: aborted). */
export async function git(args: string[], cwd: string, env: Record<string, string>, opts: GitOptions = {}): Promise<GitResult> {
  if (opts.signal?.aborted) return { code: -1, out: "", err: "stopped" };
  const p = Bun.spawn(["git", ...SAFE, ...args], {
    cwd, env: gitEnv(env, opts.env), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
  });
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

/** The object id HEAD points at, read from the files (loose refs, packed-refs) without running git there. */
export function readHead(gitDir: string): string | null {
  let target = "HEAD";
  for (let depth = 0; depth < 5; depth++) {
    if (target !== "HEAD" && (!REF_NAME.test(target) || target.split("/").some((s) => s === ".." || s === "." || s === ""))) return null;
    let value = smallFile(gitDir, target)?.trim() ?? null;
    if (value === null && target !== "HEAD") {
      for (const line of (smallFile(gitDir, "packed-refs") ?? "").split("\n")) {
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
): Promise<SeatGitOutcome | null> {
  const gitDir = join(repo, ".git");
  try {
    if (!lstatSync(gitDir).isDirectory() || !statSync(join(gitDir, "objects")).isDirectory()) return null;
  } catch {
    return null;
  }
  const scratch = mkdtempSync(join(scratchRoot, "walkie-seat-git-"));
  try {
    const inspect = join(scratch, "inspect.git");
    const init = await git(["init", "--quiet", "--bare", "--template=", inspect], scratch, env, { signal });
    if (init.code !== 0) return null;
    mkdirSync(join(inspect, "objects", "info"), { recursive: true });
    writeFileSync(join(inspect, "objects", "info", "alternates"), `${resolve(gitDir, "objects")}\n`);
    if (existsSync(join(gitDir, "index"))) {
      try { if (lstatSync(join(gitDir, "index")).isFile()) copyFileSync(join(gitDir, "index"), join(inspect, "index")); } catch { /* no index: all untracked */ }
    }
    const head = readHead(gitDir);
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
    const made = await git(["bundle", "create", out, "HEAD", ...(base ? [`^${base}`] : [])], repo, env, at);
    if (made.code !== 0 || !existsSync(out) || !statSync(out).size) return { commits, dirty };
    return { commits, dirty, bundle: out };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function readFile(path: string): Uint8Array { return new Uint8Array(readFileSync(path)); }
