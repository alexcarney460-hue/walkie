// The seat runner's v2 spec (FO-2, runner protocol 7): as a seat user it clones the bundle the daemon streams to it
// over its stdin (never a path: r1 HIGH 3),
// checks out the build's branch, writes the brief to TASK.md (kept out of the commits), runs the runtime with only
// the fixed pointer, and returns the result file with the outcome. An older runner (protocol 6) refuses a v7 spec.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_MAX_STAGED, RUNNER_PROTOCOL, RUNNER_PROTOCOL_V2, validSpec } from "../../src/daemon/seats/runner.ts";
import { SEAT_TASK_PROMPT } from "../../src/protocol/seats.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const FAKE_KIMI = join(import.meta.dir, "..", "fixtures", "fake-kimi", "kimi");
const BUN_DIR = process.execPath.slice(0, process.execPath.lastIndexOf("/"));
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

async function waitFor<T>(fn: () => T | undefined | null | false, what: string, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

function git(cwd: string, ...a: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const base = { dir_name: "20260927-120000-abc123-7", token: "ab".repeat(32), socket: "/tmp/walkie-no-such.sock", bundle_len: 0, prompt_len: 1 };

describe("the runner's v2 spec (protocol 7)", () => {
  test("v2 fields need protocol 7; a v7 bundle may be larger (streamed) but capped; an older runner refuses the spec", () => {
    const ok = { ...base, rv: RUNNER_PROTOCOL_V2, bin: "/bin/echo", args: [], env: {}, task: "brief", branch: "lane/x", result_file: "v.json", bundle_len: 300 * 1024 * 1024 };
    expect(validSpec(ok)).not.toBeNull();
    expect(validSpec({ ...ok, rv: RUNNER_PROTOCOL })).toBeNull(); // v2 fields in a v6 spec
    expect(validSpec({ ...ok, bundle_len: RUNNER_MAX_STAGED + 1 })).toBeNull();
    expect(validSpec({ ...ok, branch: "-f" })).toBeNull();
    expect(validSpec({ ...ok, branch: "main" })).toBeNull(); // only lane/… or walkie/…
    expect(validSpec({ ...ok, result_file: "../x" })).toBeNull();
    expect(validSpec({ ...base, rv: RUNNER_PROTOCOL, bin: "/bin/echo", args: [], env: {} })).not.toBeNull(); // v1 unchanged
  });

  test("clones the streamed bundle on the build's branch, writes TASK.md, runs on the fixed pointer and returns the result file", async () => {
    const root = mkdtempSync("/tmp/walkie-runner-v2-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "a.txt"), "a\n");
    git(src, "add", ".");
    git(src, "commit", "-q", "-m", "a");
    const sha = git(src, "rev-parse", "HEAD");
    const staged = join(root, "in-staged.bundle");
    git(src, "bundle", "create", staged, "HEAD");
    const log = join(root, "kimi.jsonl");
    const brief = "please commit your work and write the verdict";
    const spec = {
      ...base, rv: RUNNER_PROTOCOL_V2, bin: FAKE_KIMI, args: ["-p", SEAT_TASK_PROMPT, "--output-format", "text"],
      env: { PATH: `${BUN_DIR}:/usr/bin:/bin`, FAKE_KIMI_LOG: log, ANTHROPIC_API_KEY: "never" },
      task: brief, branch: "lane/sp-210", result_file: ".audit-private/verdict.json", bundle_len: statSync(staged).size,
    };
    const p = Bun.spawn([process.execPath, CLI, "seat-runner"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", WALKIE_SEAT_RUNNER_HOME: root, WALKIE_SEAT_FAKE_UID: `v2-${process.pid}` },
    });
    cleanups.push(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } });
    const sink = p.stdin as import("bun").FileSink;
    sink.write(`${JSON.stringify(spec)}\n`);
    sink.write(readFileSync(staged)); // the bundle's bytes over stdin, then the (1-byte) prompt
    sink.write("\n");
    sink.flush();
    const out = await new Response(p.stdout as ReadableStream<Uint8Array>).text();
    await p.exited;
    const lines = out.trim().split("\n");
    const outcome = JSON.parse((lines.find((l) => l.startsWith('r {"outcome"')) ?? "r null").slice(2)) as { outcome: Record<string, unknown> };
    expect(outcome.outcome).toMatchObject({ commits: 1 });
    expect(JSON.parse(Buffer.from(outcome.outcome.file as string, "base64").toString())).toEqual({ verdict: "PASS_WITH_FINDINGS", high: 0 });
    const launch = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0] as string) as { argv: string[]; task: string; env: string[] };
    expect(launch.argv).toEqual(["-p", "Read ./TASK.md and do it", "--output-format", "text"]); // never the brief
    expect(launch.task).toBe(brief);
    const repo = join(root, "walkie-seats", base.dir_name, "repo");
    expect(git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/lane/sp-210");
    expect(git(repo, "rev-parse", "HEAD~1")).toBe(sha);
    expect(git(repo, "show", "--name-only", "--format=", "HEAD")).toBe("kimi-output.txt"); // the brief isn't committed
    expect(existsSync(join(repo, "TASK.md"))).toBe(false); // taken out before the tree was inspected
    expect(statSync(join(root, "walkie-seats", base.dir_name, "input.bundle")).mode & 0o777).toBe(0o600);
  }, 30_000);
});
