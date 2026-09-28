// WALKIE-MISSION-1 fix round 1: the Opus audit's adversarial scenarios (A–F, C2, C3; scratchpad maudit/zz-audit.test.ts)
// and the accuracy findings (Opus 2/3/4/5/6/8, Codex 5), as regression tests. Each failed before the fix.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentArchive } from "../../src/daemon/agent-archive.ts";
import { EXITED_ACTIVITY, IDLE_HOLD_MS, MAX_PER_RUNTIME, SWEEP_GRACE_MS } from "../../src/daemon/discovery.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { agentsPayload } from "../../src/daemon/views.ts";
import { ARCHIVE_CAP_PER_NODE, OFFLINE_GRACE_MS } from "../../src/protocol/agent-roster.ts";
import { addCpu, AGENT, endTurn, hook, ME, prompt, status, toolCall, toolResult, world } from "../helpers/discovery-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const onlineSync = { isOnline: () => true } as unknown as SyncManager;
const TICK = 15_000;

describe("Opus audit scenarios", () => {
  test("A: a hook's 'waiting' (permission prompt) is never replaced because a background child burns CPU", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([toolCall("Bash", { command: "rm -rf build" })]);
    w.fx.procs.push({ pid: 102, ppid: 100, uid: ME, startedAt: w.clock.t - 50_000, command: "node next dev", cpuMs: 1_000 });
    await d.tick();
    const waiting = hook(w.core, "waiting", "Needs permission: Bash");
    for (let i = 0; i < 30; i++) { w.clock.t += TICK; addCpu(w.fx, 102, 3_000); await d.tick(); }
    expect(status(w.core, AGENT)?._id).toBe(waiting.id);
  });

  test("B: a turn ended while its dev server keeps the tree busy: idle, not working forever", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([prompt("start the dev server"), ...endTurn()]);
    w.fx.procs.push({ pid: 102, ppid: 100, uid: ME, startedAt: w.clock.t - 50_000, command: "node next dev", cpuMs: 1_000 });
    await d.tick();
    for (let i = 0; i < 40; i++) { w.clock.t += TICK; addCpu(w.fx, 102, 2_000); await d.tick(); }
    expect(status(w.core, AGENT)?.state).toBe("idle");
  });

  test("C: a slash command (/model) at an idle session is not a turn: idle within the hysteresis, not 10 minutes", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([prompt("hi"), ...endTurn()], w.clock.t - 3_600_000);
    await d.tick();
    w.write([
      { type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } },
      { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } },
      { type: "user", message: { role: "user", content: "<local-command-stdout>Set model</local-command-stdout>" } },
    ]);
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) { w.clock.t += TICK; addCpu(w.fx, 100, 100); await d.tick(); seen.push(status(w.core, AGENT)?.state as string); }
    expect(seen.every((s) => s === "idle")).toBe(true); // the command's write is not activity at all
  });

  test("C2: an Esc interrupt ends the turn: idle after the hysteresis, not 10 minutes of 'working'", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([prompt("do x"), { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }]);
    await d.tick();
    expect(status(w.core, AGENT)?.state).toBe("working"); // written just now
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) { w.clock.t += TICK; addCpu(w.fx, 100, 100); await d.tick(); seen.push(status(w.core, AGENT)?.state as string); }
    expect(seen[8]).toBe("idle");
    expect(seen.indexOf("idle") * TICK + TICK).toBeGreaterThanOrEqual(IDLE_HOLD_MS);
  });

  test("C3: a hooked idle session (Stop) where the person types /usage stays idle", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([prompt("hi"), ...endTurn()], w.clock.t - 3_600_000);
    await d.tick();
    const stop = hook(w.core, "idle", "Finished");
    w.clock.t += 60_000;
    w.write([{ type: "user", message: { role: "user", content: "<command-name>/usage</command-name>" } }, { type: "user", message: { role: "user", content: "<local-command-stdout>usage</local-command-stdout>" } }]);
    for (let i = 0; i < 36; i++) { w.clock.t += TICK; addCpu(w.fx, 100, 100); await d.tick(); }
    expect(status(w.core, AGENT)?._id).toBe(stop.id);
  });

  test("D: a tool result longer than the tail window, then minutes of model thinking: a hook's working holds", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([toolCall("Read", { file_path: "/x" })]);
    await d.tick();
    hook(w.core, "working", "Read x");
    w.write([toolResult("x".repeat(40_000))]);
    for (let i = 0; i < 16; i++) { w.clock.t += TICK; addCpu(w.fx, 100, 300); await d.tick(); }
    expect(status(w.core, AGENT)?.state).toBe("working");
  });

  test("E: a hooked long quiet tool (an ssh wait, 13 min, low CPU) keeps the hook's working", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([toolCall("Bash", { command: "ssh almond ./gate.sh" })]);
    w.fx.procs.push({ pid: 103, ppid: 100, uid: ME, startedAt: w.clock.t, command: "ssh almond", cpuMs: 0 });
    hook(w.core, "working", "Running a command");
    await d.tick();
    for (let i = 0; i < 52; i++) { w.clock.t += TICK; addCpu(w.fx, 103, 50); await d.tick(); }
    expect(status(w.core, AGENT)?.state).toBe("working");
  });

  test("F: a live hooked session discovery can't name is never swept, and takes over its card instead of a ghost", async () => {
    const w = world(cleanups);
    w.fx.env.set(101, {}); // no session id anywhere (no sessions/<pid>.json either)
    const d = w.disc();
    w.write([toolCall("Bash", { command: "bun test" })]);
    hook(w.core, "working", "Running a command"); // no cwd: can't be matched to the process
    for (let i = 0; i < 12; i++) { w.clock.t += TICK; w.write([toolCall("Bash", { command: "bun test" })]); await d.tick(); }
    expect(status(w.core, AGENT)?.state).toBe("working"); // not swept while an unnamed claude session runs

    // With the hook's cwd (repoContext's, like the process's), the unnamed session IS that card: no claude-pid100.
    const w2 = world(cleanups);
    w2.fx.env.set(101, {});
    const d2 = w2.disc();
    const cwd = (await import("../../src/agent/identity.ts")).repoContext(w2.cwd).cwd;
    const card = hook(w2.core, "idle", "Finished turn", "cc-hooked", { cwd });
    w2.clock.t += 60_000;
    await d2.tick(); // no session id: no transcript either; CPU is its evidence
    for (let i = 0; i < 2; i++) { w2.clock.t += TICK; addCpu(w2.fx, 100, 5_000); await d2.tick(); } // two busy readings
    expect(status(w2.core, "claude-pid100")).toBeNull();
    expect(status(w2.core, "cc-hooked")).toMatchObject({ state: "working", activity: "Working (seen from the process)" });
    expect(status(w2.core, "cc-hooked")?.cwd).toBeUndefined(); // matched by the locally kept cwd; not published
    expect(status(w2.core, "cc-hooked")?._id).not.toBe(card.id);
    w2.clock.t += SWEEP_GRACE_MS * 3;
    await d2.tick();
    expect(status(w2.core, "cc-hooked")?.state).not.toBe("offline");
  });
});

describe("accuracy", () => {
  test("Opus 8: bookkeeping writes (queue-operation, ai-title, last-prompt) are not activity", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([prompt("hi"), ...endTurn()], w.clock.t - 3_600_000);
    await d.tick();
    expect(status(w.core, AGENT)?.state).toBe("idle");
    for (let i = 0; i < 8; i++) {
      w.clock.t += TICK;
      w.write([{ type: "queue-operation", operation: "enqueue" }, { type: "ai-title", title: "x" }, { type: "last-prompt", text: "x" }]);
      await d.tick();
      expect(status(w.core, AGENT)?.state).toBe("idle");
    }
  });

  test("Opus 8 with timestamps: after a restart, a bookkeeping write doesn't hide that the last turn record is old", async () => {
    const w = world(cleanups);
    const old = new Date(w.clock.t - 3_600_000).toISOString();
    w.write([{ ...prompt("hi"), timestamp: old }, { ...endTurn()[0], timestamp: old }, { type: "ai-title", title: "x" }]);
    await w.disc().tick();
    expect(status(w.core, AGENT)?.state).toBe("idle");
  });

  test("Codex 5: a failed process listing after a good one changes nothing (no offline flapping)", async () => {
    const w = world(cleanups);
    let scans = 0;
    const d = w.disc();
    d.onScan = () => { scans++; };
    w.write([toolCall("Bash", { command: "bun test" })]);
    hook(w.core, "working", "Running a command", "cc-other", { runtime: "claude-code" });
    await d.tick();
    const before = status(w.core, AGENT);
    expect(before?.state).toBe("working");
    for (const mode of ["null", "throw", "empty"] as const) {
      w.fx.failList = mode;
      w.clock.t += SWEEP_GRACE_MS * 2;
      await d.tick();
      expect(status(w.core, AGENT)?._id).toBe(before?._id as string);
      expect(status(w.core, "cc-other")?.state).toBe("working");
    }
    expect(scans).toBe(1);
    w.fx.failList = null;
    w.write([toolCall("Bash", { command: "bun test" })]);
    await d.tick();
    expect(status(w.core, AGENT)?.state).toBe("working"); // never went offline in between
  });

  test("Opus 5: the session id comes from sessions/<pid>.json in the session's OWN config directory", async () => {
    const w = world(cleanups);
    w.fx.env.set(101, {}); // the MCP child carries nothing
    w.fx.sessions.set(`${w.cfg}\n100`, { sessionId: "5eed0001-1111-4222-8333-944455556666", startedAt: w.clock.t - 60_000 });
    w.write([toolCall("Bash", { command: "ls" })]);
    await w.disc().tick();
    expect(status(w.core, AGENT)?.state).toBe("working");
    expect(status(w.core, "claude-pid100")).toBeNull();
  });

  test("Opus 5: SystemProcessProvider reads <configDir>/sessions/<pid>.json of the directory it is given", async () => {
    const { SystemProcessProvider } = await import("../../src/daemon/procs.ts");
    const w = world(cleanups);
    mkdirSync(join(w.cfg, "sessions"), { recursive: true });
    writeFileSync(join(w.cfg, "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "abc-123", startedAt: 5 }));
    const p = new SystemProcessProvider();
    expect(await p.claudeSession(4242, w.cfg)).toEqual({ sessionId: "abc-123", startedAt: 5 });
    expect(await p.claudeSession(4242, join(w.root, "elsewhere"))).toBeUndefined();
  });

  test("Codex 4: a session id that isn't a plain id is never made into a path", async () => {
    const w = world(cleanups);
    w.fx.env.set(101, { CLAUDE_CODE_SESSION_ID: "../../../etc/passwd" });
    await w.disc().tick();
    expect(status(w.core, "claude-pid100")).not.toBeNull(); // unnamed: the bad id was dropped
    expect(JSON.stringify(status(w.core, "claude-pid100"))).not.toContain("passwd");
  });
});

describe("Opus 6: non-agent sessions and bounded discovery", () => {
  test("claude-mem observers (by parent or by cwd) are not agents; the real Mac counts: 303 observers + 89 sessions", async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    const t = w.clock.t;
    w.fx.procs.push({ pid: 43861, ppid: 1, uid: ME, startedAt: t - 9e6, command: "/opt/homebrew/bin/bun /Users/u/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs --daemon", cpuMs: 1 });
    for (let i = 0; i < 300; i++) {
      w.fx.procs.push({ pid: 50_000 + i, ppid: 43861, uid: ME, startedAt: t - i * 1000, command: "/Users/u/.local/bin/claude --output-format stream-json --model claude-haiku-4-5 --no-session-persistence", cpuMs: 5 });
    }
    for (let i = 0; i < 3; i++) { // observers whose parent is gone: excluded by their cwd
      w.fx.procs.push({ pid: 60_000 + i, ppid: 1, uid: ME, startedAt: t - i * 1000, command: "claude --no-session-persistence", cpuMs: 5 });
      w.fx.cwds.set(60_000 + i, join(w.root, "claude-mem", "observer-sessions", String(4300 + i)));
    }
    for (let i = 0; i < 89; i++) {
      w.fx.procs.push({ pid: 70_000 + i, ppid: 1, uid: ME, startedAt: t - i * 1000, command: "claude", cpuMs: 5 });
      w.fx.cwds.set(70_000 + i, w.cwd);
    }
    const d = w.disc();
    await d.tick();
    const mine = w.core.store.agents().filter((r) => r.node === w.core.nodeId);
    expect(mine.length).toBe(89);
    expect(mine.every((r) => /^claude-pid7\d{4}$/.test(r.agent))).toBe(true);
    // The observers' cwd is looked up once, never again while they run.
    const before = w.fx.cwds.size;
    await d.tick();
    expect(w.fx.cwds.size).toBe(before);
  });

  test(`at most MAX_PER_RUNTIME (${MAX_PER_RUNTIME}) sessions per runtime; an over-full runtime is not swept`, async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    for (let i = 0; i < 12; i++) w.fx.procs.push({ pid: 80_000 + i, ppid: 1, uid: ME, startedAt: w.clock.t - i * 1000, command: "codex", cpuMs: 1 });
    hook(w.core, "working", "x", "codex-hooked", { runtime: "codex" });
    const d = w.disc({ maxPerRuntime: 5 });
    w.clock.t += SWEEP_GRACE_MS * 2;
    await d.tick();
    const posted = w.core.store.agents().filter((r) => r.agent.startsWith("codex-pid"));
    expect(posted.map((r) => r.agent).sort()).toEqual([0, 1, 2, 3, 4].map((i) => `codex-pid${80_000 + i}`).sort()); // the newest five
    expect(status(w.core, "codex-hooked")?.state).toBe("working"); // it may be one of the seven not reported
  });

  test("worker-b's 787 idle agent-<pid> MCP cards: swept (parent gone) a bounded batch per scan, then held to the archive cap", async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    const t0 = w.clock.t;
    for (let i = 0; i < 787; i++) hook(w.core, "idle", "Connected to Walkie", `agent-${(10_000 + i).toString(36)}`, { runtime: "cli" });
    w.clock.t = t0 + SWEEP_GRACE_MS;
    const d = w.disc();
    for (let i = 0; i < 8; i++) { await d.tick(); w.clock.t += TICK; }
    const rows = () => w.core.store.agents().filter((r) => r.agent.startsWith("agent-"));
    expect(rows().filter((r) => (JSON.parse(r.body) as { state: string }).state === "offline").length).toBe(787);
    expect(status(w.core, `agent-${(10_000).toString(36)}`)?.activity).toBe(EXITED_ACTIVITY);
    const later = w.clock.t + OFFLINE_GRACE_MS + 1;
    const archive = new AgentArchive(w.core, onlineSync, createLogger({}), { now: () => later });
    archive.tick();
    expect(rows().length).toBe(ARCHIVE_CAP_PER_NODE);
    expect(agentsPayload(w.core, onlineSync, {}, later).agents.filter((a) => a.agent.startsWith("agent-")).length).toBe(0);
  });
});

describe("Opus 4: a last record beyond the tail window", () => {
  test("is read back to its start (a tool result in flight: mid-turn), and beyond the read-back limit what was known stands", async () => {
    const { SessionFiles, READ_BACK_MAX } = await import("../../src/daemon/activity.ts");
    const w = world(cleanups);
    w.write([toolCall("Read", { file_path: "/x" }), toolResult("y".repeat(40_000))]);
    const files = new SessionFiles({ detail: true });
    expect(files.read(w.transcript, "claude")?.info).toMatchObject({ midTurn: true });
    w.write([toolCall("Read", { file_path: "/z" })]);
    expect(files.read(w.transcript, "claude")?.info).toMatchObject({ midTurn: true, toolRunning: true, step: "Read /z" });
    w.write([toolResult("z".repeat(READ_BACK_MAX + 10))]);
    const huge = files.read(w.transcript, "claude")?.info;
    expect(huge).toMatchObject({ unknown: true, midTurn: true, toolRunning: true }); // kept, not "the turn ended"
    utimesSync(w.transcript, new Date(w.clock.t), new Date(w.clock.t));
  });
});
