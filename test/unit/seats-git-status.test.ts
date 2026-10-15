import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatOutcome } from "../../src/daemon/seats/git.ts";

test("seat outcome counts same-size tracked edits even when the copied index trusts stale stat data", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-seat-status-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Seat", "-c", "user.email=seat@example.com", ...args], { cwd: repo, stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    run("init", "-q", "-b", "main");
    writeFileSync(join(repo, "first.txt"), "before\n");
    writeFileSync(join(repo, "second.txt"), "before\n");
    run("add", ".");
    run("commit", "-q", "-m", "base");
    const base = run("rev-parse", "HEAD");
    writeFileSync(join(repo, "committed.txt"), "new\n");
    run("add", "committed.txt");
    run("commit", "-q", "-m", "seat work");
    // Force Git's stale-index fast path: it skips stat checks for these entries.
    run("update-index", "--assume-unchanged", "first.txt", "second.txt");
    writeFileSync(join(repo, "first.txt"), "AFTER!\n");
    writeFileSync(join(repo, "second.txt"), "AFTER!\n");
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    const outcome = await seatOutcome(repo, base, join(root, "result.bundle"), { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root });
    expect(outcome).toMatchObject({ commits: 1, dirty: 3 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
