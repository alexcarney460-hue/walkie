// Seats v2 end to end (FO-2) on a 2-machine team with a FAKE kimi on the seats' PATH (test/fixtures/fake-kimi):
// alex (owner) launches v2 seats on arvid's machine (same-user seats). Covers: a Kimi seat that gets its brief as
// TASK.md and only the fixed pointer on argv, with no provider key in its environment; a build lane in arvid's own
// clone (.worktrees/<label> on lane/<label>, its commit returned, the brief not committed); an audit detached at the
// exact commit returning verdict.json; a delta bundle with missing prerequisites refused; the result file returned on
// a stop; a symlinked result file refused; an account the host may not use refused `account_not_usable`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { TERMINAL_STATES, seatAgentName, seatsChannel, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUN_DIR = dirname(process.execPath);

let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let log: string;
let clone: string;
let sha0: string;

function person(n: TestNode): WalkieClient { return n.client(""); }
const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const ended = (id: string, timeoutMs = 30_000) =>
  waitFor(async () => { const s = await seatOn(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs, what: `seat ${id} to end` });
const launches = (): Array<Record<string, unknown>> =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const launchOf = (brief: string) => waitFor(() => launches().find((l) => l.task === brief), { what: `the kimi run for "${brief}"` });

function g(cwd: string, ...a: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// Kimi seats are full access only (FO-2 r1 MEDIUM 7).
const v2 = (brief: string, over: Record<string, unknown> = {}) =>
  person(alex).seatRun({ machine: "arvid-mac", runtime: "kimi", permission_mode: "bypassPermissions", brief, ...over });
/** The seats' PATH: fakes only (claude/codex also exist in /opt/homebrew/bin on dev Macs: never reached from here). */
let bin: string;

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "arvid-home");
  mkdirSync(home, { recursive: true });
  log = join(c.root, "kimi.jsonl");
  bin = join(c.root, "seat-bin");
  mkdirSync(bin);
  for (const [dir, name] of [["fake-kimi", "kimi"], ["fake-codex", "codex"], ["fake-claude", "claude"]] as const) symlinkSync(join(FIXTURES, dir, name), join(bin, name));
  clone = join(c.root, "arvid-clone");
  mkdirSync(clone);
  g(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "README.md"), "app\n");
  g(clone, "add", ".");
  g(clone, "commit", "-q", "-m", "init");
  sha0 = g(clone, "rev-parse", "HEAD");
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    // Its stats carry the seats_v2 capability the run route checks (FO-2 r1 LOW: unknown is refused).
    machineStats: { intervalMs: 200, read: async () => ({ mem: null, temp_c: null }) },
    seats: {
      flushMs: 100, launchesPerMinute: 100,
      env: {
        PATH: `${bin}:${BUN_DIR}:/usr/bin:/bin`, HOME: home, FAKE_KIMI_LOG: log,
        OPENAI_API_KEY: "sk-never", KIMI_API_KEY: "never", MOONSHOT_API_KEY: "never", GEMINI_API_KEY: "never", GITHUB_TOKEN: "x",
      },
    },
  });
  // API keys in the seat env file (~/.walkie/seat-env, pre.7) and the daemon's environment: none may reach a seat.
  writeFileSync(join(arvid.d.core.paths.home, "seat-env"), ("export UNIT_MARK=1\nexport ANTHROPIC_API_KEY=sk" + "-ant-api03-never\nexport KIMI_API_KEY=never\nexport MOONSHOT_API_KEY=never\n"));
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  const { local } = await person(arvid).seatsConfig({ allow: true, same_user: true, env: ["FAKE_KIMI_LOG"] });
  expect(local.runtimes).toEqual(["claude", "codex"]); // Kimi is opt-in (FO-2 r1 MEDIUM 7)
  await waitFor(() => alex.d.sync.peerState(arvid.d.nodeId)?.stats?.sys?.caps?.includes("seats_v2") ?? null, { what: "arvid's seats_v2 capability" });
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid-mac takes seats" });
  await waitFor(async () => (await alex.client().team()).channels.find((x) => x.name === seatsChannel(arvid.d.nodeId)), { what: "seats channel on alex" });
}, 60_000);

afterAll(async () => { await c.close(); });

describe("v2 seats", () => {
  test("the seat card title is the brief's first line when prompts are shared", async () => {
    const cfg = join(arvid.home, "config.json");
    const original = readFileSync(cfg, "utf8");
    writeFileSync(cfg, JSON.stringify({ ...(JSON.parse(original) as object), share_prompts: true }));
    try {
      const res = await person(alex).seatRun({ machine: "arvid-mac", runtime: "codex", brief: "First line of brief\nSecond private line" });
      const name = seatAgentName(res.seat);
      const row = await waitFor(() => {
        const body = arvid.d.core.store.agent(arvid.d.nodeId, name)?.body;
        return body?.includes("First line of brief") ? JSON.parse(body) as Record<string, unknown> : null;
      }, { what: "v2 seat card title" });
      expect(row.title).toBe("First line of brief");
      expect(JSON.stringify(row)).not.toContain("Second private line");
      await ended(res.seat);
    } finally {
      writeFileSync(cfg, original);
    }
  }, 30_000);

  test("r1 MEDIUM 7: Kimi is off until the host's person turns it on, and then only full access", async () => {
    const off = await v2("kimi while off");
    expect((await ended(off.seat)).reason).toMatch(/doesn't allow kimi: its person runs `walkie seats allow --runtimes claude,codex,kimi` there/);
    const { local } = await person(arvid).seatsConfig({ allow: true, runtimes: ["claude", "codex", "kimi"] });
    expect(local.runtimes).toEqual(["claude", "codex", "kimi"]);
    for (const permission_mode of ["acceptEdits", "default"]) {
      await expect(v2("not full access", { permission_mode })).rejects.toThrow(/runs its tools without asking/);
    }
    await expect(person(alex).seatRun({ machine: "arvid-mac", runtime: "kimi", brief: "no mode" })).rejects.toThrow(/runs its tools without asking/);
  }, 30_000);

  test("the machine's person maps a repo id to its clone; an agent only while agent admin is on, audited (pre.8 merge)", async () => {
    await arvid.client().adminSwitches({ agent_admin: false });
    await expect(arvid.client("cc-1").seatsRepoSet("app", clone)).rejects.toThrow(/agent admin is off/);
    await arvid.client().adminSwitches({ agent_admin: true });
    await arvid.client("cc-1").seatsRepoSet("app-agent", clone);
    expect(readFileSync(join(arvid.home, "admin-audit.jsonl"), "utf8")).toContain("set the seats repo app-agent");
    await arvid.client("cc-1").seatsRepoSet("app-agent", null);
    await expect(person(arvid).seatsRepoSet("app", join(c.root, "nope"))).rejects.toThrow(/not a directory/);
    const { repos } = await person(arvid).seatsRepoSet("app", clone);
    expect(repos.app).toBe(realpathSync(clone));
    const cfg = JSON.parse(readFileSync(join(arvid.home, "config.json"), "utf8")) as { fleet?: { repos?: Record<string, string> } };
    expect(cfg.fleet?.repos?.app).toBe(realpathSync(clone));
  }, 30_000);

  test("a Kimi seat: the brief is TASK.md, argv is only the fixed pointer, no provider key in its environment", async () => {
    const brief = "say hello (a private brief: 7c1f)";
    const res = await v2(brief);
    const s = await ended(res.seat);
    expect(`${s.state} ${s.reason ?? ""}`.trim()).toBe("done");
    expect(s).toMatchObject({ v: 2, runtime: "kimi", prompt: "" });
    expect(s.brief).toMatch(/^[0-9a-f]{64}$/);
    expect(s.output.map((o) => o.text).join("\n")).toContain("kimi: done");
    const run = await launchOf(brief);
    expect(run.argv).toEqual(["-p", "Read ./TASK.md and do it", "--output-format", "text"]);
    expect(JSON.stringify(run.argv)).not.toContain("7c1f");
    expect(run.stdin).toBe("");
    expect(run.env).toEqual(expect.arrayContaining(["WALKIE_AGENT", "WALKIE_SEAT_TOKEN_FILE"]));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN", "WALKIE_HOME"]) {
      expect(run.env as string[]).not.toContain(k);
    }
    // Neither the request post nor any post in the channel carries the brief.
    const posts = await alex.client().events({ channel: seatsChannel(arvid.d.nodeId), limit: 200 });
    expect(JSON.stringify(posts)).not.toContain("7c1f");
  }, 40_000);

  test("a build lane: .worktrees/<label> on lane/<label> in arvid's clone, its commit returned, the brief not committed", async () => {
    const res = await v2("commit the work", { label: "sp-210", workspace: { repo: "app", ref: "main", mode: "branch" } });
    const s = await ended(res.seat);
    expect(`${s.state} ${s.reason ?? ""}`.trim()).toBe("done");
    expect(s.commits).toBe(1);
    expect(s.result_bundle).toMatch(/^[0-9a-f]{64}$/);
    const wt = join(realpathSync(clone), ".worktrees", "sp-210");
    expect(realpathSync((await launchOf("commit the work")).cwd as string)).toBe(wt);
    expect(g(wt, "symbolic-ref", "HEAD")).toBe("refs/heads/lane/sp-210");
    expect(g(wt, "rev-parse", "HEAD~1")).toBe(sha0);
    expect(g(wt, "show", "--name-only", "--format=", "HEAD")).toBe("kimi-output.txt");
    expect(existsSync(join(wt, "TASK.md"))).toBe(false);
    expect(readFileSync(join(clone, ".git", "info", "exclude"), "utf8")).not.toContain("TASK.md"); // the clone left as it was
    const bytes = await alex.client().fetchArtifact(s.result_bundle as string);
    expect(bytes.byteLength).toBeGreaterThan(0);
  }, 40_000);

  test("an audit: detached at the exact commit, verdict.json returned as the result file", async () => {
    const res = await v2("write the verdict", { label: "sp-210-a1", workspace: { repo: "app", ref: sha0, mode: "detached" }, result_file: ".audit-private/verdict.json" });
    const s = await ended(res.seat);
    expect(`${s.state} ${s.reason ?? ""}`.trim()).toBe("done");
    const wt = join(realpathSync(clone), ".worktrees", "sp-210-a1");
    expect(g(wt, "rev-parse", "HEAD")).toBe(sha0);
    expect(Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"], { cwd: wt }).exitCode).not.toBe(0);
    expect(s.result_file_blob).toMatch(/^[0-9a-f]{64}$/);
    const verdict = JSON.parse(new TextDecoder().decode(await alex.client().fetchArtifact(s.result_file_blob as string))) as Record<string, unknown>;
    expect(verdict).toEqual({ verdict: "PASS_WITH_FINDINGS", high: 0 });
  }, 40_000);

  test("a delta bundle whose prerequisites arvid's clone lacks is refused with the reason", async () => {
    const other = join(c.root, "alex-diverged");
    mkdirSync(other);
    g(other, "init", "-q", "-b", "main");
    for (const n of ["x", "y", "z"]) { writeFileSync(join(other, n), n); g(other, "add", n); g(other, "commit", "-q", "-m", n); }
    const bundleFile = join(c.root, "delta.bundle");
    g(other, "bundle", "create", bundleFile, "main", "^HEAD~1");
    const missing = g(other, "rev-parse", "HEAD~1");
    const { hash } = await alex.client().seatsBundle(new Uint8Array(readFileSync(bundleFile)));
    const res = await v2("commit on the delta", { label: "sp-211", workspace: { repo: "app", ref: "main", mode: "branch", bundle: hash } });
    const s = await ended(res.seat);
    expect(s.state).toBe("refused");
    expect(s.reason).toContain("doesn't apply to repo app's branches and tags on this machine");
    expect(s.reason).toContain(missing.slice(0, 12));
    expect(launches().some((l) => l.task === "commit on the delta")).toBe(false); // nothing ran
  }, 40_000);

  test("the result file comes back on a stop; a symlinked result file is refused", async () => {
    const res = await v2("write the verdict, then slow", { result_file: ".audit-private/verdict.json" });
    await launchOf("write the verdict, then slow");
    await waitFor(async () => ((await seatOn(res.seat))?.state === "running" ? true : null), { what: "running" });
    await Bun.sleep(300); // the verdict is written before the slow part
    await person(alex).seatStop(res.seat);
    const s = await ended(res.seat);
    expect(s.state).toBe("stopped");
    expect(s.result_file_blob).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(new TextDecoder().decode(await alex.client().fetchArtifact(s.result_file_blob as string)))).toMatchObject({ verdict: "PASS_WITH_FINDINGS" });

    const sym = await v2("symlink-verdict", { result_file: ".audit-private/verdict.json" });
    const t = await ended(sym.seat);
    expect(t.state).toBe("done");
    expect(t.result_file_blob).toBeUndefined();
    expect(t.file_error).toBe("refused: it is a symlink");
  }, 60_000);

  test("a v2 request is never sent to a host whose daemon doesn't announce seats_v2, or hasn't said", async () => {
    const sync = alex.d.sync;
    const real = sync.peerCapabilities;
    try {
      // A pre.5 execution host: its last-known protocol features lack v2.
      sync.peerCapabilities = (id) => id === arvid.d.nodeId ? { version: "0.2.0-pre.5", caps: [] } : real.call(sync, id);
      await expect(v2("hello")).rejects.toThrow(/doesn't take v2 seat requests/);
      // The execution host is unknown: wait for its first capability announcement.
      sync.peerCapabilities = (id) => id === arvid.d.nodeId ? undefined : real.call(sync, id);
      await expect(v2("hello")).rejects.toThrow(/hasn't said yet whether it takes v2 seat requests/);
      // A v1 request still goes (to the fake codex on the seats' PATH).
      const v1 = await person(alex).seatRun({ machine: "arvid-mac", runtime: "codex", prompt: "a v1 seat" });
      expect((await ended(v1.seat)).state).toBe("done");
    } finally {
      sync.peerCapabilities = real;
    }
  }, 30_000);

  test("an account this machine may not use is refused account_not_usable, before anything runs", async () => {
    const res = await v2("never runs", { account: `arvid:${"a".repeat(24)}` });
    const s = await ended(res.seat);
    expect(s.state).toBe("refused");
    expect(s.reason).toMatch(/^account_not_usable: /);
    const other = await v2("never runs either", { account: `alex:${"b".repeat(24)}` });
    expect((await ended(other.seat)).reason).toMatch(/^account_not_usable: /);
    expect(launches().some((l) => String(l.task).startsWith("never runs"))).toBe(false);
  }, 30_000);

  // ---- r1 MEDIUM 4: the brief never outlives its seat, however it ends -------------------------------------------
  const MARK = "# walkie seat brief (removed when no seat runs in this clone)\n/TASK.md\n";
  const lane = (label: string) => join(realpathSync(clone), ".worktrees", label);
  const exclude = () => readFileSync(join(clone, ".git", "info", "exclude"), "utf8");
  const running = (id: string) => waitFor(async () => ((await seatOn(id))?.state === "running" ? true : null), { what: `seat ${id} running` });

  test("a stop by the host's own person: the result file comes back, the brief is gone, the lane is free", async () => {
    const brief = "write the verdict, then slow (stop-1)";
    const res = await v2(brief, { label: "stop-1", workspace: { repo: "app", ref: "main", mode: "detached" }, result_file: ".audit-private/verdict.json" });
    await launchOf(brief);
    await running(res.seat);
    expect(existsSync(join(lane("stop-1"), "TASK.md"))).toBe(true);
    // r2 MED 2: the brief's cleanup record is on disk while it exists (written before it, durably).
    const rec = (JSON.parse(readFileSync(join(arvid.home, "seats.json"), "utf8")) as { running: Array<{ id: string; task?: { cwd: string; file: string; hash?: string } }> }).running.find((r) => r.id === res.seat);
    expect(rec?.task?.file).toBe("TASK.md");
    expect(rec?.task?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(realpathSync(rec?.task?.cwd as string)).toBe(lane("stop-1"));
    await Bun.sleep(300);
    await person(arvid).seatStop(res.seat); // this machine's person: a local stop (the post-run git is aborted)
    const s = await ended(res.seat);
    expect(s.state).toBe("stopped");
    expect(s.result_file_blob).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(lane("stop-1"), "TASK.md"))).toBe(false);
    expect(exclude()).not.toContain(MARK);
    // What's left in the lane is the seat's own output, never the brief; once that is dealt with, the lane is reusable.
    expect(g(lane("stop-1"), "status", "--porcelain")).toBe("?? .audit-private/");
    rmSync(join(lane("stop-1"), ".audit-private"), { recursive: true });
    const again = await v2("commit (stop-1 again)", { label: "stop-1", workspace: { repo: "app", ref: "main", mode: "detached" } });
    const a = await ended(again.seat);
    expect(`${a.state} ${a.reason ?? ""}`.trim()).toBe("done");
  }, 60_000);

  test("a runtime that can't be found: the seat fails, the brief is gone, the lane is free", async () => {
    rmSync(join(bin, "kimi"));
    try {
      const res = await v2("never starts (spawn-1)", { label: "spawn-1", workspace: { repo: "app", ref: "main", mode: "detached" } });
      const s = await ended(res.seat);
      expect(s.state).toBe("failed");
      expect(s.reason).toMatch(/kimi was not found/);
      expect(existsSync(join(lane("spawn-1"), "TASK.md"))).toBe(false);
      expect(exclude()).not.toContain(MARK);
    } finally {
      symlinkSync(join(FIXTURES, "fake-kimi", "kimi"), join(bin, "kimi"));
    }
    const again = await v2("runs now (spawn-1)", { label: "spawn-1", workspace: { repo: "app", ref: "main", mode: "detached" } });
    expect((await ended(again.seat)).state).toBe("done");
  }, 60_000);

  test("a daemon shutdown takes the brief out; after a crash, the next start does", async () => {
    const brief = "slow (shutdown-1)";
    const res = await v2(brief, { label: "shutdown-1", workspace: { repo: "app", ref: "main", mode: "detached" } });
    await launchOf(brief);
    await running(res.seat);
    expect(existsSync(join(lane("shutdown-1"), "TASK.md"))).toBe(true);
    await arvid.stop();
    expect(existsSync(join(lane("shutdown-1"), "TASK.md"))).toBe(false);
    expect(exclude()).not.toContain(MARK);
    // A crash (no clean stop): seats.json still names the brief; it is removed at the next start.
    writeFileSync(join(lane("shutdown-1"), "TASK.md"), "left by a crash\n");
    writeFileSync(join(clone, ".git", "info", "exclude"), `${exclude()}${MARK}`);
    const state = join(arvid.home, "seats.json");
    const saved = JSON.parse(readFileSync(state, "utf8")) as { running: unknown[] };
    const record = { id: res.seat, dir: join(c.root, "gone"), task: { cwd: lane("shutdown-1"), file: "TASK.md", exclude: join(realpathSync(clone), ".git", "info", "exclude") } };
    writeFileSync(state, JSON.stringify({ ...saved, running: [record] }));
    await arvid.start();
    expect(existsSync(join(lane("shutdown-1"), "TASK.md"))).toBe(false);
    expect(exclude()).not.toContain(MARK);
  }, 60_000);

  test("pre.8: `walkie seats allow --dir '~/workspace/app'` (a quoted tilde) is stored as ~/workspace/app, not ~/~/…", async () => {
    const r = await runAsPerson([process.execPath, CLI, "seats", "allow", "--same-user", "--dir", "~/workspace/app", "--json"],
      { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: arvid.home, WALKIE_SOCKET: arvid.socket });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(arvid.home, "config.json"), "utf8")) as { seats?: { dir?: string } };
    expect(cfg.seats?.dir).toBe("~/workspace/app");
    // Expanded once, against the seats' HOME (this test's arvid-home), never a second "~/".
    const shown = (JSON.parse(r.out) as { local: { dir: string } }).local.dir;
    expect(shown).not.toContain("~/~");
    expect(shown.endsWith("arvid-home/workspace/app")).toBe(true);
  }, 30_000);
});
