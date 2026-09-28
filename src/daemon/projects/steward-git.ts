// FO-6 board steward: what a project's local git repositories say about its cards. Read-only git with fixed argv
// (for-each-ref, reflog, rev-list, log); never a shell, never a write, each call bounded by a timeout.
//
// Ref names come from the repository (a tag or branch fetched from a shared remote is anyone's text), so they never
// reach argv as themselves (fix round 2, Opus HIGH 1: a tag named `--output=<path>` truncated a file):
//   - every ref is read and passed as its FULL name (`refs/heads/…`, `refs/remotes/…`, `refs/tags/…`), which can't
//     start with "-"; a name whose short form starts with "-" (or has a control character) is skipped altogether;
//   - revisions go after `--end-of-options`, and exclusions are `^refs/…` revisions, not a `--not` list;
//   - every call runs with no system or global config and the program-running settings off (the FO-2 seats set:
//     hooks, fsmonitor, external diff, sshCommand, credential helpers, askpass, pager, signatures, `ext::`), with no
//     prompts and no optional locks. The repository's own .git/config is still read (it is the person's clone); none
//     of the commands here runs a filter, a diff driver or a hook.
//
//   own commits  the larger of: commits since the branch was created, from its reflog's first entry ("branch: Created
//                from …"; a branch forked from a release branch with no work of its own is NOT merged work: a fresh
//                lane branch is trivially an ancestor of the branch it came from), and, for a branch not created here
//                (one that arrived by `git fetch` of a bundle has its finished tip as its first reflog entry), commits
//                in no release ref.
//   merged       its tip is in a release branch (main, master, release/…, release-…, …-release-…) or one of the two
//                newest tags; only a branch with reflog-counted own commits can show merged work
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BranchEvidence } from "../../protocol/projects/steward.ts";

const GIT_TIMEOUT_MS = 10_000;
/** Lane branches examined per repository per run (each costs up to four git calls). */
export const MAX_BRANCHES = 400;
/** Refs read per namespace; a repository with more is scanned partially (its coverage marked incomplete). */
export const MAX_REFS = 20_000;
const RELEASE_RE = /^(?:main|master|release[-/][^/]+|[^/]*-release-[^/]*)$/i;
/** Branches that are never a lane's work (a team may keep pre-rebase copies under backup/). */
const IGNORED_RE = /^(?:backup|tmp|wip-backup)\//i;

/** Command-line settings for every call (they outrank the repository's config): nothing runs a program. */
const SAFE = [
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.sshCommand=false",
  "-c", "core.attributesFile=/dev/null", "-c", "credential.helper=", "-c", "core.askPass=", "-c", "core.pager=cat",
  "-c", "submodule.recurse=false", "-c", "protocol.ext.allow=never", "-c", "log.showSignature=false", "-c", "gpg.program=false",
];

export interface GitRun { (dir: string, args: readonly string[], signal?: AbortSignal): Promise<{ code: number; out: string }> }

/** Output one git call may produce (bytes); past it the call is killed and counts as failed. */
export const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const chunk of stream) {
    n += chunk.byteLength;
    if (n > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Runs git read-only in `dir`: isolated config, no pager, no prompts, no optional locks; killed on `signal`. */
export const runGit: GitRun = async (dir, args, signal) => {
  if (signal?.aborted) return { code: -1, out: "" };
  const proc = Bun.spawn(["git", "-C", dir, "--no-pager", ...SAFE, ...args], {
    stdout: "pipe", stderr: "ignore", stdin: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", LANG: "C", LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/echo", GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
  const kill = () => proc.kill();
  const timer = setTimeout(kill, GIT_TIMEOUT_MS);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const out = await readCapped(proc.stdout, MAX_GIT_OUTPUT);
    if (out === null) { kill(); await proc.exited; return { code: -1, out: "" }; }
    const code = await proc.exited;
    return { code: signal?.aborted ? -1 : code, out };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
};

/** `~/x` -> the home directory; a directory that is a git work tree (or bare repository) stays, anything else goes. */
export function repoDirs(dirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of dirs) {
    const d = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw === "~" ? homedir() : raw;
    if (!d.startsWith("/") || !existsSync(d)) continue;
    if (existsSync(join(d, ".git")) || existsSync(join(d, "HEAD"))) out.push(d);
  }
  return [...new Set(out)];
}

/** A ref: its full name (what goes on argv) and its name under its namespace (what the rules match). */
interface Ref { full: string; name: string }

/** A ref name the steward will pass to git at all: under its namespace, no leading "-", no control characters. */
export function safeRefName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith("-") && !/[\x00-\x20\x7f]/.test(name);
}

/** One scan: its git runner, deadline and whether anything was cut short or failed. */
interface Scan { readonly git: GitRun; readonly dir: string; readonly signal?: AbortSignal; incomplete: boolean }

async function call(sc: Scan, args: readonly string[]): Promise<{ code: number; out: string }> {
  const r = await sc.git(sc.dir, args, sc.signal);
  if (r.code !== 0) sc.incomplete = true;
  return r;
}

async function refs(sc: Scan, namespace: "refs/heads/" | "refs/remotes/" | "refs/tags/", extra: string[] = []): Promise<Ref[] | null> {
  const r = await call(sc, ["for-each-ref", ...extra, `--count=${MAX_REFS + 1}`, "--format=%(refname)", namespace]);
  if (r.code !== 0) return null;
  const lines = r.out.split("\n").filter(Boolean);
  if (lines.length > MAX_REFS) sc.incomplete = true;
  const out: Ref[] = [];
  for (const full of lines.slice(0, MAX_REFS)) {
    if (!full.startsWith(namespace)) continue;
    const name = full.slice(namespace.length);
    if (safeRefName(name)) out.push({ full, name });
  }
  return out;
}

async function count(sc: Scan, revs: readonly string[]): Promise<number> {
  const r = await call(sc, ["rev-list", "--count", "--max-count=10000", "--end-of-options", ...revs, "--"]);
  return r.code === 0 ? Number(r.out.trim()) || 0 : 0;
}

/**
 * The branch's own commits (since its reflog's first entry, or outside every release ref), whether they came from the
 * reflog (only those can show merged work), and its tip's commit time.
 */
async function ownWork(sc: Scan, ref: string, releases: readonly Ref[]): Promise<{ own: number; since: number; at: number | null }> {
  // No reflog is exit 0 with no output (not a failure); a failed read (error, timeout, output cap) leaves the
  // coverage unknown (round 3, Codex r2 MED 5).
  const log = await call(sc, ["reflog", "show", "--format=%H %gs", "--end-of-options", ref, "--"]);
  const first = log.code === 0 ? log.out.split("\n").filter(Boolean).pop() : undefined;
  const created = first?.split(" ")[0];
  const sha = created && /^[0-9a-f]{40,64}$/.test(created) ? created : undefined;
  const since = sha ? await count(sc, [ref, `^${sha}`]) : 0;
  // Created here from another branch: the reflog count is exact (commits outside the releases would count the parent
  // lane's work too). Arrived any other way (a fetched bundle): the commits in no release ref are its work.
  const local = !!first && / branch: Created from /.test(` ${first.slice(first.indexOf(" ") + 1)}`);
  const own = local ? since : Math.max(since, await count(sc, [ref, ...releases.map((r) => `^${r.full}`)]));
  if (!own) return { own: 0, since: 0, at: null };
  const tip = await call(sc, ["log", "-1", "--format=%ct", "--end-of-options", ref, "--"]);
  const at = tip.code === 0 ? Number(tip.out.trim()) * 1000 : NaN;
  return { own, since, at: Number.isFinite(at) && at > 0 ? at : null };
}

export interface RepoScan {
  readonly branches: Array<BranchEvidence & { card: string }>;
  /** false: a git call failed, timed out, hit a cap or the run's deadline: what's missing is unknown, not absent. */
  readonly complete: boolean;
  /** Cards whose lane branches were beyond MAX_BRANCHES (their coverage is incomplete even when the rest is). */
  readonly skipped: ReadonlySet<string>;
}

/**
 * The lane branches of one repository that `wanted` claims (a card's code or key is in the name), with their own
 * commits and where they are merged. Null: not a git repository (or git failed on its first call).
 */
export async function scanRepo(dir: string, wanted: (branch: string) => string | null, git: GitRun = runGit, signal?: AbortSignal): Promise<RepoScan | null> {
  const sc: Scan = { git, dir, ...(signal ? { signal } : {}), incomplete: false };
  const heads = await refs(sc, "refs/heads/");
  if (!heads) return null;
  const remotes = (await refs(sc, "refs/remotes/")) ?? [];
  const tags = (await refs(sc, "refs/tags/", ["--sort=-creatordate"]))?.slice(0, 2) ?? [];
  const releases: Ref[] = [
    ...heads.filter((h) => RELEASE_RE.test(h.name)).slice(0, 20),
    ...remotes.filter((h) => /^[^/]+\/(?:main|master)$/.test(h.name)).slice(0, 5),
    ...tags,
  ];
  const lanes: Array<Ref & { card: string }> = [];
  const skipped = new Set<string>();
  for (const h of heads) {
    if (RELEASE_RE.test(h.name) || IGNORED_RE.test(h.name)) continue;
    const card = wanted(h.name);
    if (!card) continue;
    if (lanes.length >= MAX_BRANCHES) skipped.add(card); else lanes.push({ ...h, card });
  }
  const mergedInto = new Map<string, string>();
  if (lanes.length) {
    for (const rel of releases) {
      const r = await call(sc, ["for-each-ref", `--merged=${rel.full}`, `--count=${MAX_REFS}`, "--format=%(refname)", "refs/heads/"]);
      if (r.code !== 0) continue;
      for (const full of r.out.split("\n")) if (full && !mergedInto.has(full)) mergedInto.set(full, rel.name);
    }
  }
  const branches: Array<BranchEvidence & { card: string }> = [];
  for (const l of lanes) {
    if (signal?.aborted) { sc.incomplete = true; break; }
    const w = await ownWork(sc, l.full, releases);
    const merged = w.since > 0 ? mergedInto.get(l.full) ?? null : null;
    branches.push({ card: l.card, repo: dir, branch: l.name, own_commits: w.own, last_commit_at: w.at, merged_into: merged });
  }
  return { branches, complete: !sc.incomplete && !signal?.aborted, skipped };
}
