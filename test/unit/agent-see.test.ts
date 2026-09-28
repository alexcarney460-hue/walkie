import { afterEach, expect, test } from "bun:test";
import { classifyAgent, modelServers } from "../../src/daemon/agent-procs.ts";
import { parsePs } from "../../src/daemon/procs.ts";
import { hook, ME, status, world } from "../helpers/discovery-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

test("all supported runtime entry points; renamed Kimi and headless workers", () => {
  for (const [command, runtime] of [
    ["kimi-code", "kimi"], ["kimi -p [REDACTED]", "kimi"], ["claude -p [REDACTED]", "claude-code"],
    ["codex exec [REDACTED]", "codex"], ["/x/grok-1.2.3-linux-x64 --prompt [REDACTED]", "grok"],
    ["node /x/@google/gemini-cli/dist/index.js --prompt [REDACTED]", "gemini"], ["opencode run [REDACTED]", "opencode"],
  ]) expect(classifyAgent(command!, null)).toMatchObject({ runtime, launch: "headless" });
  expect(classifyAgent("claude-agent-acp")).toMatchObject({ runtime: "claude-code", launch: "acp" });
  for (const cmd of ["codex-code-mode-host", "node /x/server.js kimi", "claude mcp serve", "codex app-server", "kimi mcp", "ollama serve", "rpc-server", "bash -lc claude -p [REDACTED]"]) {
    expect(classifyAgent(cmd)).toBeNull();
  }
});

test("Linux and macOS ps tty/time columns preserve start time without prompts in output", () => {
  const rows = parsePs("100 1 1000 pts/3 00:00:05 Sun Sep 27 13:30:48 2026 kimi-code\n101 1 501 ?? 0:01.32 Sun Sep 27 13:30:48 2026 claude -p [REDACTED]\n");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ pid: 100, tty: "pts/3", cpuMs: 5000 });
  expect(rows[1]).toMatchObject({ pid: 101, tty: null, cpuMs: 1320 });
});

test("unhooked runtimes stay visible as working, project basename only by default", async () => {
  const w = world(cleanups, { activity: false, prompts: false });
  w.fx.procs = [w.fx.procs[0]!, ...["kimi-code", "claude -p PRIVATE_PROMPT", "codex exec PRIVATE_PROMPT", "grok", "gemini", "opencode run PRIVATE_PROMPT"].map((command, i) => ({ pid: 200 + i, ppid: 1, uid: ME, startedAt: w.clock.t - 300000, command, tty: null }))];
  for (let i = 0; i < 6; i++) w.fx.cwds.set(200 + i, `${w.root}/private-project`);
  const d = w.disc();
  await d.tick();
  const rows = w.core.store.agents();
  expect(rows).toHaveLength(6);
  for (const r of rows) {
    expect(JSON.parse(r.body)).toMatchObject({ state: "working", repo: "private-project", launch: "headless" });
    expect(r.body).not.toContain("PRIVATE_PROMPT");
    expect(r.body).not.toContain(w.root);
  }
  w.clock.t += 300000;
  await d.tick();
  expect(w.core.store.agents().every((r) => JSON.parse(r.body).state === "working")).toBe(true);
});

test("ACP bridge and runtime relaunches count once; ordinary helpers never count", async () => {
  const w = world(cleanups);
  const cmds = [[200, 1, "claude-agent-acp"], [201, 200, "claude -p [REDACTED]"], [202, 201, "node /x/mcp.js"],
    [300, 1, "gemini"], [301, 300, "node /x/@google/gemini-cli/dist/index.js"], [400, 1, "opencode"], [401, 400, "/x/.opencode"]] as const;
  w.fx.procs = [w.fx.procs[0]!, ...cmds.map(([pid, ppid, command]) => ({ pid, ppid, command, uid: ME, startedAt: w.clock.t }))];
  const found = await w.disc().scan();
  expect(found.map((a) => a.pid)).toEqual([201, 300, 400]);
  expect(found[0]?.launch).toBe("acp");
});

test("two Kimi processes in one directory adopt two hook cards without duplicate cards", async () => {
  const w = world(cleanups);
  w.fx.procs = [w.fx.procs[0]!, ...[200, 201].map((pid) => ({ pid, ppid: 1, command: "kimi-code", uid: ME, startedAt: w.clock.t }))];
  for (const pid of [200, 201]) w.fx.cwds.set(pid, w.cwd);
  for (const a of ["kimi-aaa111", "kimi-bbb222"]) hook(w.core, "working", "Thinking", a, { runtime: "kimi", cwd: w.cwd });
  const d = w.disc();
  await d.tick();
  await d.tick();
  expect(w.core.store.agents().map((a) => a.agent).sort()).toEqual(["kimi-aaa111", "kimi-bbb222"]);
});

test("a hook arriving after discovery retires the pid card instead of keeping a ghost", async () => {
  const w = world(cleanups);
  w.fx.procs = [w.fx.procs[0]!, { pid: 200, ppid: 1, command: "kimi-code", uid: ME, startedAt: w.clock.t }];
  w.fx.cwds.set(200, w.cwd);
  const d = w.disc();
  await d.tick();
  hook(w.core, "waiting", "Needs your permission", "kimi-aaa111", { runtime: "kimi", cwd: w.cwd });
  await d.tick();
  expect(status(w.core, "kimi-pid200")?.state).toBe("offline");
  expect(status(w.core, "kimi-aaa111")?.state).toBe("waiting");
});

test("model servers are counted separately from agents, including a service user", async () => {
  expect(modelServers(["ollama serve", "ollama runner --model [REDACTED]", "llama-server", "rpc-server", "rpc-server", "claude"])).toEqual([
    { name: "rpc-server", count: 2 }, { name: "llama-server", count: 1 }, { name: "ollama", count: 1 },
  ]);
  const w = world(cleanups);
  w.fx.procs = [w.fx.procs[0]!, { pid: 200, ppid: 1, uid: 999, startedAt: w.clock.t, command: "ollama serve" }];
  await w.disc().tick();
  expect(w.core.modelServers).toEqual([{ name: "ollama", count: 1 }]);
  expect(w.core.store.agents()).toHaveLength(0);
});
