// AGENT-SEE-1 review round p8 (Codex, 6 MEDIUM): Kimi session binding, adoption across restarts, option parsing,
// read failures, the scan budget, and the liveness rule the older discovery tests pin.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAgent } from "../../src/daemon/agent-procs.ts";
import { DISCOVERED_ACTIVITY } from "../../src/daemon/discovery.ts";
import {
  assignKimiSessions, CREATE_WINDOW_MS, kimiBucketHash, listKimiSessions, ScanBudget, type KimiSession,
} from "../../src/daemon/kimi-sessions.ts";
import { addCpu, hook, ME, status, world } from "../helpers/discovery-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const OLD = "0a0a0a0a-0000-4000-8000-000000000001";
const NEW = "0b0b0b0b-0000-4000-8000-000000000002";
const sess = (id: string, createdAt: number, updatedAt = createdAt): KimiSession => ({ id, file: `/k/${id}/wire.jsonl`, root: "/k", createdAt, updatedAt });

/** A Kimi home with sessions for `cwd` (state.json + an empty wire.jsonl), as Kimi Code 0.37 / 0.43 lays them out. */
function kimiHome(root: string, cwd: string, list: Array<{ id: string; createdAt: number; updatedAt?: number }>): string {
  const home = join(root, "kimi-home");
  const bucket = join(home, "sessions", `wd_repo_${kimiBucketHash(cwd)}`);
  for (const s of list) {
    const dir = join(bucket, `session_${s.id}`);
    mkdirSync(join(dir, "agents", "main"), { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ id: `session_${s.id}`, cwd, createdAt: s.createdAt, updatedAt: s.updatedAt ?? s.createdAt }));
    writeFileSync(join(dir, "agents", "main", "wire.jsonl"), "");
  }
  return home;
}

describe("#1 Kimi binds a process only to a session it provably owns", () => {
  const T = 1_790_000_000_000;

  test("a resumed session and a newer one in the same directory: each process gets its own", () => {
    // A resumed OLD (created an hour before it started, written since); B started 30 s after A and created NEW.
    const out = assignKimiSessions(
      [{ key: "a", startedAt: T }, { key: "b", startedAt: T + 30_000 }],
      [sess(OLD, T - 3_600_000, T + 90_000), sess(NEW, T + 31_000, T + 95_000)], new Set(),
    );
    expect(out.get("a")?.id).toBe(OLD);
    expect(out.get("b")?.id).toBe(NEW);
  });

  test("the resumed process alone (before B's lookup) never takes a session created after it started", () => {
    const out = assignKimiSessions([{ key: "a", startedAt: T }], [sess(OLD, T - 3_600_000, T + 90_000), sess(NEW, T + 31_000)], new Set());
    // NEW falls in A's creation window, so it is creatable; the only session A can have resumed is OLD.
    expect(out.get("a")?.id).toBe(OLD);
  });

  test("two processes that started together are ambiguous: neither is bound", () => {
    const out = assignKimiSessions([{ key: "a", startedAt: T }, { key: "b", startedAt: T + 2_000 }], [sess(OLD, T + 1_000), sess(NEW, T + 3_000)], new Set());
    expect(out.size).toBe(0);
  });

  test("two resumed processes, or two candidate sessions, stay unbound; a taken session is never given again", () => {
    const two = [sess(OLD, T - 7_200_000, T + 60_000), sess(NEW, T - 3_600_000, T + 70_000)];
    expect(assignKimiSessions([{ key: "a", startedAt: T }], two, new Set()).size).toBe(0);
    expect(assignKimiSessions([{ key: "a", startedAt: T }, { key: "b", startedAt: T + 1 }], [two[0]!], new Set()).size).toBe(0);
    expect(assignKimiSessions([{ key: "a", startedAt: T }], [sess(NEW, T + 1_000)], new Set([NEW])).size).toBe(0);
    expect(assignKimiSessions([{ key: "a", startedAt: T }], [sess(NEW, T + CREATE_WINDOW_MS + 5_000)], new Set()).size).toBe(0);
  });

  test("end to end: discovery names the resumed and the new process after their own sessions", async () => {
    const w = world(cleanups);
    const t = w.clock.t;
    const home = kimiHome(w.root, w.cwd, [{ id: OLD, createdAt: t - 3_600_000, updatedAt: t - 10_000 }, { id: NEW, createdAt: t - 29_000 }]);
    w.fx.procs = [w.fx.procs[0]!,
      { pid: 200, ppid: 1, uid: ME, startedAt: t - 60_000, command: "kimi-code", tty: null },
      { pid: 201, ppid: 1, uid: ME, startedAt: t - 30_000, command: "kimi-code", tty: null }];
    for (const pid of [200, 201]) { w.fx.cwds.set(pid, w.cwd); w.fx.env.set(pid, { KIMI_CODE_HOME: home }); }
    const found = await w.disc().scan();
    expect(Object.fromEntries(found.map((a) => [a.pid, a.agent]))).toEqual({ 200: "kimi-0a0a0a", 201: "kimi-0b0b0b" });
  });
});

describe("#2 a hook card a process took over stays its own across scans that miss it and across restarts", () => {
  test("restart: the persisted takeover keeps the card; no pid card, no offline", async () => {
    const w = world(cleanups);
    w.fx.procs = [w.fx.procs[0]!, { pid: 200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "kimi-code", tty: null }];
    w.fx.cwds.set(200, w.cwd);
    hook(w.core, "working", "Thinking", "kimi-aaa111", { runtime: "kimi", cwd: w.cwd });
    const d1 = w.disc();
    await d1.tick();
    w.clock.t += 20 * 60_000; // the hook went quiet; the process keeps working (CPU): discovery re-posts the card, its own now
    for (let i = 0; i < 3; i++) { addCpu(w.fx, 200, 5_000); w.clock.t += 15_000; await d1.tick(); }
    expect(w.core.store.getMeta("discovery_owned") ?? "").toContain("kimi-aaa111");
    const d2 = w.disc(); // a daemon restart: a new discovery, the same store
    await d2.tick();
    await d2.tick();
    const names = w.core.store.agents().map((r) => r.agent);
    expect(names).toContain("kimi-aaa111");
    expect(names).not.toContain("kimi-pid200");
    expect(status(w.core, "kimi-aaa111")?.state).not.toBe("offline");
  });

  test("a scan that doesn't examine the process (budget) keeps the takeover; its exit ends it", async () => {
    const w = world(cleanups);
    const kimi = { pid: 200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "kimi-code" };
    w.fx.procs = [w.fx.procs[0]!, kimi];
    w.fx.cwds.set(200, w.cwd);
    hook(w.core, "working", "Thinking", "kimi-aaa111", { runtime: "kimi", cwd: w.cwd });
    const d = w.disc({ maxPerRuntime: 1 });
    await d.tick();
    // Over the cap: a second, newer Kimi is examined first this time; the first keeps its card.
    w.fx.procs = [...w.fx.procs, { pid: 201, ppid: 1, uid: ME, startedAt: w.clock.t, command: "kimi-code" }];
    await d.tick();
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== 201);
    w.clock.t += 60_000;
    await d.tick();
    expect(w.core.store.agents().map((r) => r.agent)).not.toContain("kimi-pid200");
    expect(status(w.core, "kimi-aaa111")?.state).not.toBe("offline");
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== 200);
    await d.tick();
    expect(status(w.core, "kimi-aaa111")?.state).toBe("offline");
    expect(w.core.store.getMeta("discovery_adopted")).toBe("{}");
  });
});

describe("#3 options before a subcommand, and an interpreter's own options", () => {
  test("helpers behind global options are no agents; sessions behind them still are", () => {
    for (const cmd of ["codex --config x=1 app-server", "codex -c a=b -m gpt mcp-server", "claude --model sonnet mcp serve",
      "claude --add-dir /a /b --verbose mcp list", "claude --settings /s.json doctor", "opencode --log-level INFO serve", "claude --model x --version"]) {
      expect(classifyAgent(cmd)).toBeNull();
    }
    expect(classifyAgent("codex -c x=1 exec fix it")).toMatchObject({ runtime: "codex", launch: "headless" });
    expect(classifyAgent("claude -p mcp")).toMatchObject({ runtime: "claude-code", launch: "headless" }); // the prompt, not a subcommand
    expect(classifyAgent("claude --resume abc123")).toMatchObject({ runtime: "claude-code" });
    expect(classifyAgent("claude --model opus")).toMatchObject({ runtime: "claude-code" });
    // A variadic option takes every word up to the next option, as commander parses it: these are directories.
    expect(classifyAgent("claude --add-dir /a /b mcp")).toMatchObject({ runtime: "claude-code" });
  });

  test("node / bun options with values don't hide the script; an inline program runs none", () => {
    expect(classifyAgent("node --require /opt/bootstrap.js /opt/@google/gemini-cli/dist/index.js")).toMatchObject({ runtime: "gemini" });
    expect(classifyAgent("node --max-old-space-size=8192 --import /x/hook.mjs /x/@anthropic-ai/claude-code/cli.js -p go")).toMatchObject({ runtime: "claude-code", launch: "headless" });
    expect(classifyAgent("bun run --cwd /w /x/@anthropic-ai/claude-code/cli.js")).toMatchObject({ runtime: "claude-code" });
    expect(classifyAgent("node -e x /x/@anthropic-ai/claude-code/cli.js")).toBeNull();
    expect(classifyAgent("node /x/@anthropic-ai/claude-code/cli.js mcp serve")).toBeNull();
  });
});

describe("#4 a session file that fails to read keeps the last verdict", () => {
  test("idle stays idle when the transcript read fails; after the hold, CPU decides", async () => {
    const w = world(cleanups);
    w.write([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, { type: "system", subtype: "turn_duration" }], w.clock.t - 5 * 60_000);
    const d = w.disc();
    await d.tick();
    w.clock.t += 15_000;
    await d.tick();
    expect(status(w.core, "cc-5eed00")?.state).toBe("idle");
    rmSync(w.transcript); // the transcript can't be read now (a transient failure looks the same)
    for (let i = 0; i < 3; i++) { w.clock.t += 15_000; await d.tick(); }
    expect(status(w.core, "cc-5eed00")?.state).toBe("idle");
  });
});

describe("#5 the scan budget bounds Kimi's lookup", () => {
  test("an exhausted budget reads nothing and binds nothing (next scan tries again)", () => {
    const w = world(cleanups);
    const home = kimiHome(w.root, w.cwd, [{ id: NEW, createdAt: w.clock.t }]);
    expect(listKimiSessions(home, w.cwd, null, new ScanBudget(Date.now() - 1, 1_000))).toBeNull(); // deadline passed
    expect(listKimiSessions(home, w.cwd, null, new ScanBudget(Date.now() + 60_000, 2))).toBeNull(); // too few operations
    expect(listKimiSessions(home, w.cwd, null, new ScanBudget(Date.now() + 60_000, 1_000))?.map((s) => s.id)).toEqual([NEW]);
  });

  test("processes sharing a directory are matched together: a session none of them created binds none", async () => {
    const w = world(cleanups);
    const t = w.clock.t;
    const home = kimiHome(w.root, w.cwd, [{ id: NEW, createdAt: t - 5 * 60_000 }]);
    const pids = [200, 201, 202, 203];
    w.fx.procs = [w.fx.procs[0]!, ...pids.map((pid) => ({ pid, ppid: 1, uid: ME, startedAt: t - 3 * 60_000 + pid, command: "kimi-code", tty: null }))];
    for (const pid of pids) { w.fx.cwds.set(pid, w.cwd); w.fx.env.set(pid, { KIMI_CODE_HOME: home }); }
    const found = await w.disc({ scanBudgetMs: 60_000 }).scan();
    expect(found.map((a) => a.agent).sort()).toEqual(pids.map((p) => `kimi-pid${p}`));
  });
});

describe("#6 liveness: a headless run without a session file is working; an interactive one is judged by CPU", () => {
  test("headless (no terminal) vs interactive (a terminal) Kimi with no session found", async () => {
    const w = world(cleanups);
    w.fx.procs = [w.fx.procs[0]!,
      { pid: 200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "kimi-code", tty: null },
      { pid: 201, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "kimi-code", tty: "pts/1" }];
    const d = w.disc();
    await d.tick();
    expect(status(w.core, "kimi-pid200")).toMatchObject({ state: "working", launch: "headless" });
    expect(status(w.core, "kimi-pid201")).toMatchObject({ state: "idle", activity: DISCOVERED_ACTIVITY });
    expect(status(w.core, "kimi-pid201")?.launch).toBeUndefined();
  });
});

describe("#1 (cont.) a sibling tried recently still competes", () => {
  test("B, due for a lookup, never takes the session A (looked up moments ago) may have created", async () => {
    const w = world(cleanups);
    const t = w.clock.t;
    const home = kimiHome(w.root, w.cwd, []);
    w.fx.procs = [w.fx.procs[0]!, { pid: 200, ppid: 1, uid: ME, startedAt: t, command: "kimi-code", tty: null }];
    w.fx.cwds.set(200, w.cwd); w.fx.env.set(200, { KIMI_CODE_HOME: home });
    const d = w.disc();
    w.clock.t += 5_000;
    expect((await d.scan()).map((a) => a.agent)).toEqual(["kimi-pid200"]); // A: no session on disk yet
    // A writes its session (t+1 s); B started at t+3 s. Ten seconds on, only B is due for a lookup.
    kimiHome(w.root, w.cwd, [{ id: NEW, createdAt: t + 1_000 }]);
    w.fx.procs = [...w.fx.procs, { pid: 201, ppid: 1, uid: ME, startedAt: t + 3_000, command: "kimi-code", tty: null }];
    w.fx.cwds.set(201, w.cwd); w.fx.env.set(201, { KIMI_CODE_HOME: home });
    w.clock.t += 10_000;
    const names = Object.fromEntries((await d.scan()).map((a) => [a.pid, a.agent]));
    expect(names).toEqual({ 200: "kimi-pid200", 201: "kimi-pid201" }); // either could have created it: neither is bound
  });
});
