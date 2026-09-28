// The seat runner on its own (`walkie seat-runner`, src/daemon/seats/runner.ts): its stdin protocol, control lines,
// and that nothing of a seat outlives its daemon: when the daemon dies (the runner's stdin closes), the runner kills
// the runtime's whole group, paused or not. With seats as another OS user, the daemon can't signal them itself.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_PROTOCOL, validSpec } from "../../src/daemon/seats/runner.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const FAKE_CODEX = join(import.meta.dir, "..", "fixtures", "fake-codex", "codex");
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stat = (pid: number) => Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();

async function waitFor<T>(fn: () => T | undefined | null | false, what: string, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

function startRunner(prompt: string, over: Record<string, unknown> = {}) {
  const root = mkdtempSync("/tmp/walkie-runner-");
  const marker = `runner-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, "codex.jsonl");
  const spec = {
    rv: RUNNER_PROTOCOL, dir_name: "20260926-120000-abc123-1", bin: FAKE_CODEX, args: ["exec", "--json", "-C", "{cwd}", "-"],
    env: { PATH: `${join(import.meta.dir, "..", "fixtures", "fake-codex")}:${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`, FAKE_CODEX_LOG: log },
    token: "ab".repeat(32), socket: "/tmp/walkie-no-such.sock", bundle_len: 0, prompt_len: Buffer.byteLength(prompt), ...over,
  };
  const p = Bun.spawn([process.execPath, CLI, "seat-runner"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", WALKIE_SEAT_RUNNER_HOME: root, WALKIE_SEAT_FAKE_UID: marker },
  });
  cleanups.push(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } });
  const sink = p.stdin as import("bun").FileSink;
  sink.write(`${JSON.stringify(spec)}\n${prompt}`);
  sink.flush();
  let out = "";
  void (async () => {
    const r = (p.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) { const x = await r.read(); if (x.done) break; out += new TextDecoder().decode(x.value); }
  })();
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  return { p, sink, root, marker, lines, out: () => out };
}

describe("the seat runner", () => {
  test("a spec it doesn't understand is refused, never run", () => {
    expect(validSpec({ rv: RUNNER_PROTOCOL + 1 })).toBeNull();
    const ok = { rv: RUNNER_PROTOCOL, dir_name: "20260926-120000-abc-1", bin: "/bin/echo", args: [], env: {}, token: "ab".repeat(32), socket: "/tmp/s", bundle_len: 0, prompt_len: 1 };
    expect(validSpec(ok)).not.toBeNull();
    expect(validSpec({ ...ok, dir_name: "../../etc" })).toBeNull();
    expect(validSpec({ ...ok, bin: "echo" })).toBeNull();
    expect(validSpec({ ...ok, token: "short" })).toBeNull();
    expect(validSpec({ ...ok, bundle_len: 30 * 1024 * 1024 })).toBeNull();
  });

  test("it reports ready, relays the runtime's lines framed, and hides the token in a 0600 file", async () => {
    const r = startRunner("hello from the runner");
    await waitFor(() => r.out().includes('r {"outcome"'), "the outcome");
    const out = r.out().trim().split("\n");
    expect(out[0]).toStartWith('r {"ready":');
    expect(out.some((l) => l.startsWith("o ") && l.includes("codex: hello from the runner"))).toBe(true);
    expect(out.some((l) => l === 'r {"exit":0}')).toBe(true);
    const launched = r.lines().find((l) => l.prompt);
    expect(launched?.env).toContain("WALKIE_SEAT_TOKEN_FILE");
    expect(launched?.env).not.toContain("WALKIE_SEAT_TOKEN");
    expect(String(launched?.cwd).startsWith(join(r.root, "walkie-seats", "20260926-120000-abc123-1"))).toBe(true);
    expect(await r.p.exited).toBe(0);
    // The token file is gone once the seat is over.
    expect(existsSync(join(r.root, "walkie-seats", "20260926-120000-abc123-1", ".walkie-seat-token"))).toBe(false);
  });

  // (A paused seat's runner is stopped too, as every process of its user is: after a crash then, the reap of every
  // pool user at the next daemon start ends it: test/integration/seats-fix3.test.ts.)
  test("its daemon dying (stdin closed) ends the runtime's whole group", async () => {
    const r = startRunner("spawn ticker 600");
    const run = await waitFor(() => r.lines().find((l) => l.prompt), "the runtime");
    const pid = run.pid as number;
    const kid = await waitFor(() => r.lines().find((l) => typeof l.grandchild === "number")?.grandchild as number | undefined, "its child");
    cleanups.push(() => { for (const x of [pid, kid]) if (alive(x)) { process.kill(x, "SIGCONT"); process.kill(x, "SIGKILL"); } });
    const mode = statSync(join(r.root, "walkie-seats", "20260926-120000-abc123-1", ".walkie-seat-token")).mode & 0o777;
    expect(mode).toBe(0o600);
    r.sink.end(); // the daemon is gone
    await waitFor(() => !alive(pid) && !alive(kid), "the group killed", 5_000);
    await r.p.exited;
  });
});

describe("the seat runner after its runtime exits (Codex r3 MEDIUM 5)", () => {
  test("a leftover that inherited the runtime's stdout is reaped at once; the exit is reported without waiting for it", async () => {
    const r = startRunner("inherit-stdout");
    const w = await waitFor(() => r.lines().find((l) => typeof l.worker === "number")?.worker as number | undefined, "the worker");
    cleanups.push(() => { if (alive(w)) process.kill(w, "SIGKILL"); });
    const t0 = Date.now();
    await waitFor(() => r.out().includes('r {"exit":0}'), "the exit report", 8_000);
    expect(Date.now() - t0).toBeLessThan(6_000); // the reap (2 s grace at most) and the bounded drain, not the leftover's life
    await waitFor(() => !alive(w), "the leftover killed", 3_000);
    await r.p.exited;
  });
});

describe("the run's own runtime configuration (Codex r4 HIGH 2, Alex 2026-09-26)", () => {
  test("a fresh CLAUDE_CONFIG_DIR with hooks off, the machine's login delivered 0600 for this run, a fresh CODEX_HOME", async () => {
    const r = startRunner("check-home", { claude_credentials: '{"claudeAiOauth":{"accessToken":"x"}}' });
    await waitFor(() => r.out().includes('r {"outcome"'), "the outcome");
    const seen = r.lines().find((l) => "claude_config" in l) as { claude_config: string; settings: string; credentials: { text: string; mode: string } };
    expect(seen.claude_config.startsWith(join(r.root, "walkie-seats"))).toBe(true);
    expect(JSON.parse(seen.settings)).toEqual({ disableAllHooks: true });
    expect(seen.credentials).toEqual({ text: '{"claudeAiOauth":{"accessToken":"x"}}', mode: "600" });
    await r.p.exited;
  });

  test("the permission-prompts probe runs the runtime as the seat user, and adds the flag it knows", async () => {
    const claude = join(import.meta.dir, "..", "fixtures", "fake-claude", "claude");
    const log = join(mkdtempSync("/tmp/walkie-claude-"), "claude.jsonl");
    cleanups.push(() => rmSync(join(log, ".."), { recursive: true, force: true }));
    const prompt = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n";
    const r = startRunner(prompt, {
      bin: claude, prompt_len: Buffer.byteLength(prompt), probe_permission_prompts: true,
      args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--session-id", "0e0b8f4e-5b7c-4d2f-9d2e-1b2c3d4e5f60", "--permission-mode", "acceptEdits"],
      env: { PATH: `${join(import.meta.dir, "..", "fixtures", "fake-claude")}:${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STATE: join(log, "..", "state") },
    });
    await waitFor(() => r.out().includes('r {"exit"'), "the exit");
    const launch = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[] }).find((l) => l.argv && !l.argv.includes("--help"));
    expect(launch?.argv?.slice(-2)).toEqual(["--permission-prompts", "none"]);
    await r.p.exited;
  });
});
