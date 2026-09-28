// FO-6 board steward: what a real git repository says about lane branches (read-only scan).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit, scanRepo } from "../../src/daemon/projects/steward-git.ts";

let dir = "";
let src = "";
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
}

beforeAll(() => {
  dir = mkdtempSync("/tmp/steward-git-");
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "base");
  // merged work: created here, two commits, merged into main
  git(dir, "checkout", "-q", "-b", "lane/merged-1");
  commit(dir, "m1"); commit(dir, "m2");
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "-m", "merge", "lane/merged-1");
  // a fresh branch from main with no work: an ancestor of main, but not merged work
  git(dir, "branch", "lane/fresh-1");
  // unmerged work
  git(dir, "checkout", "-q", "-b", "lane/open-1");
  commit(dir, "o1");
  git(dir, "checkout", "-q", "main");
  // a branch that arrives by fetch (its first reflog entry is its finished tip)
  src = mkdtempSync("/tmp/steward-git-src-");
  git(src, "clone", "-q", dir, ".");
  git(src, "checkout", "-q", "-b", "lane/fetched-1");
  commit(src, "f1"); commit(src, "f2"); commit(src, "f3");
  git(dir, "fetch", "-q", src, "lane/fetched-1:lane/fetched-1");
  git(dir, "branch", "backup/merged-1-old", "lane/merged-1");
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }); });

test("own commits from the reflog or outside the releases; merged only for reflog-counted work; backups ignored", async () => {
  const got = await scanRepo(dir, (b) => (/(merged|fresh|open|fetched)-1/.exec(b)?.[1] ?? null));
  const rows = (got?.branches ?? []).map((b) => [b.card, b.branch, b.own_commits, b.merged_into, b.last_commit_at !== null]).sort();
  expect(got?.complete).toBe(true);
  expect(rows).toEqual([
    ["fetched", "lane/fetched-1", 3, null, true],
    ["fresh", "lane/fresh-1", 0, null, false],
    ["merged", "lane/merged-1", 2, "main", true],
    ["open", "lane/open-1", 1, null, true],
  ]);
});

test("hostile ref names never reach argv as options (fix round 2, Opus HIGH 1): no file is touched", async () => {
  const hostile = mkdtempSync("/tmp/steward-git-hostile-");
  try {
    git(hostile, "init", "-q", "-b", "main");
    commit(hostile, "base");
    writeFileSync(join(hostile, "victim.txt"), "keep me");
    writeFileSync(join(hostile, "victim2.txt"), "keep me too");
    const head = git(hostile, "rev-parse", "HEAD");
    // What a clone or fetch from a shared remote can bring: tags and branches named like options.
    git(hostile, "update-ref", "refs/tags/--output=victim.txt", head);
    git(hostile, "update-ref", "refs/heads/--release-x", head);
    git(hostile, "update-ref", "refs/heads/--output=victim2.txt", head);
    git(hostile, "checkout", "-q", "-b", "lane/x-1");
    commit(hostile, "x1");
    git(hostile, "update-ref", "refs/heads/lane/--output=victim2.txt", "HEAD");
    const argv: string[][] = [];
    const logged = async (d: string, a: readonly string[]) => { argv.push([...a]); return runGit(d, a); };
    const got = await scanRepo(hostile, (b) => (b.startsWith("lane/") || b.startsWith("-") ? "card" : null), logged);
    expect(readFileSync(join(hostile, "victim.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(hostile, "victim2.txt"), "utf8")).toBe("keep me too");
    // No argument before `--end-of-options` is anything but the steward's own fixed options.
    for (const a of argv) {
      const end = a.indexOf("--end-of-options");
      const opts = end < 0 ? a : a.slice(0, end);
      expect(opts.filter((x) => /output|release-x/.test(x))).toEqual([]);
    }
    expect((got?.branches ?? []).map((b) => b.branch).sort()).toEqual(["lane/--output=victim2.txt", "lane/x-1"]);
  } finally {
    rmSync(hostile, { recursive: true, force: true });
  }
});

test("a failing git call or the run's deadline marks the scan incomplete (Codex MED 6/7)", async () => {
  const flaky = async (d: string, a: readonly string[], sig?: AbortSignal) => (a[0] === "rev-list" ? { code: 1, out: "" } : runGit(d, a, sig));
  const got = await scanRepo(dir, (b) => (/(merged|open)-1/.exec(b)?.[1] ?? null), flaky);
  expect(got?.complete).toBe(false);
  // A reflog read that fails (timeout, output cap, error) is unknown, not "no reflog" (Codex r2 MED 5).
  const noReflog = async (d: string, a: readonly string[], sig?: AbortSignal) => (a[0] === "reflog" ? { code: -1, out: "" } : runGit(d, a, sig));
  expect((await scanRepo(dir, (b) => (/(merged|open)-1/.exec(b)?.[1] ?? null), noReflog))?.complete).toBe(false);
  const ac = new AbortController();
  ac.abort();
  expect((await scanRepo(dir, () => "x", runGit, ac.signal))).toBeNull();
});

test("not a repository: null", async () => {
  const empty = mkdtempSync("/tmp/steward-nogit-");
  try { expect(await scanRepo(empty, () => "x")).toBeNull(); } finally { rmSync(empty, { recursive: true, force: true }); }
});
