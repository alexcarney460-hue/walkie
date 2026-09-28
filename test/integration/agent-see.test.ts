// AGENT-SEE-1: hook-independent discovery end to end — a teammate's /v1/agents and `walkie who` show unhooked
// runtimes (a headless Kimi seat, `claude -p`, Grok) with launch labels, without ever publishing a prompt; local model
// servers are machine load on the node, not agents.
import { afterAll, describe, expect, test } from "bun:test";
import type { ProcessProvider, ProcRow } from "../../src/daemon/procs.ts";
import { renderWho } from "../../src/cli/commands/team.ts";
import { Cluster, waitFor } from "../helpers/cluster.ts";

const UID = 4343;
const START = 1_790_000_000_000; // far enough back to be a long-running session

class Procs implements ProcessProvider {
  constructor(public procs: ProcRow[], private readonly cwds: Map<number, string>) {}
  async list(): Promise<ProcRow[]> { return this.procs; }
  async envVars() { return new Map<number, Record<string, string>>(); }
  async cwd(pid: number): Promise<string | undefined> { return this.cwds.get(pid); }
  async openFiles(): Promise<string[]> { return []; }
  async claudeSession() { return undefined; }
}

const c = new Cluster();
afterAll(async () => { await c.close(); });

describe("AGENT-SEE-1: unhooked runtimes are visible team-wide", () => {
  test("kimi seat, claude -p and grok appear in /v1/agents and who with launch labels; ollama is machine load", async () => {
    const procs = new Procs(
      [
        { pid: 1, ppid: 0, uid: 0, startedAt: 1, command: "/sbin/init" },
        { pid: 10, ppid: 1, uid: UID, startedAt: START, command: "kimi-code", tty: null },
        { pid: 11, ppid: 1, uid: UID, startedAt: START, command: "claude -p PRIVATE_PROMPT", tty: null },
        { pid: 12, ppid: 1, uid: UID, startedAt: START, command: "grok --prompt PRIVATE_PROMPT", tty: "pts/4" },
        { pid: 13, ppid: 10, uid: UID, startedAt: START, command: "node /x/mcp-server.js" }, // helper: never an agent
        { pid: 99, ppid: 1, uid: 999, startedAt: START, command: "ollama serve" }, // another user's model server
      ],
      new Map([[10, "/home/alex/private-project"], [11, "/home/alex/private-project"], [12, "/home/alex/grokproj"]]),
    );
    const alex = await c.add({ name: "see-alex", login: "see-alex@example.com", discovery: { provider: procs, uid: UID, intervalMs: 50 },
      machineStats: { intervalMs: 50, read: async () => ({ mem: { total: 16 * 1024 ** 3, used: 8 * 1024 ** 3, swap_used: 0, pressure: "normal" as const }, temp_c: null }) } });
    const kira = await c.add({ name: "see-kira", login: "see-kira@example.com" });
    await alex.client().init("acme", "alex");
    await alex.client().invite("see-kira@example.com", "kira", "member");
    expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);

    const agents = await waitFor(async () => {
      const list = (await kira.client().agents()).agents;
      return ["kimi-pid10", "claude-pid11", "grok-pid12"].every((n) => list.some((a) => a.agent === n)) ? list : undefined;
    }, { what: "three discovered agents on kira" });
    const byName = new Map(agents.map((a) => [a.agent, a]));
    expect(byName.get("kimi-pid10")?.status).toMatchObject({ runtime: "kimi", state: "working" });
    expect(byName.get("claude-pid11")?.status).toMatchObject({ runtime: "claude-code", launch: "headless", state: "working" });
    expect(byName.get("grok-pid12")?.status).toMatchObject({ runtime: "other", runtime_name: "grok", state: "working" });
    expect(agents.some((a) => a.agent.includes("mcp"))).toBe(false);
    // Privacy: project basenames only, never a prompt or an absolute path.
    for (const n of ["kimi-pid10", "claude-pid11"]) expect(byName.get(n)?.status.repo).toBe("private-project");
    const wire = JSON.stringify(agents);
    expect(wire).not.toContain("PRIVATE_PROMPT");
    expect(wire).not.toContain("/home/alex");

    // `walkie who` renders the labels the dashboard shows.
    const who = renderWho(await kira.client().team(), agents);
    expect(who).toContain("kimi · headless");
    expect(who).toContain("claude · headless");
    expect(who).toContain("grok");

    // The model server rides the machine's stats, not the agent list.
    const stats = await waitFor(async () =>
      (await kira.client().team()).nodes.find((n) => n.node_id === alex.d.nodeId)?.stats?.model_servers,
    { what: "ollama in alex's machine stats on kira" });
    expect(stats).toEqual([{ name: "ollama", count: 1 }]);
    expect(agents.some((a) => a.agent.includes("ollama"))).toBe(false);
  });
});
