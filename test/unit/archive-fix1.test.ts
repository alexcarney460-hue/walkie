// WALKIE-MISSION-1 fix round 1, the Agent archive: filters before the page is cut, paging with total/truncated
// (Codex 6, Opus 10), an archive revision that changes with the contents even when the counts don't (Codex 7), and the
// new CLI / MCP against a daemon from before MISSION-1 (Codex 8).
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { AgentArchive } from "../../src/daemon/agent-archive.ts";
import type { Core } from "../../src/daemon/core.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { DEFAULT_LIMITS } from "../../src/daemon/ratelimit.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { agentsPayload } from "../../src/daemon/views.ts";
import { callTool } from "../../src/mcp/tools.ts";
import { ARCHIVE_CAP_PER_NODE, IDLE_ARCHIVE_MS } from "../../src/protocol/agent-roster.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, ev, nodeEv, now, tnode, type TNode } from "../helpers/events.ts";
import { fakeDaemon } from "../helpers/fake-daemon.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const onlineSync = { isOnline: () => true } as unknown as SyncManager;
const CLI = join(import.meta.dir, "../../src/cli/main.ts");

/** Six machines of one person, each with `per` archived idle agents. */
function sixMachines(per: number): { core: Core; team: string; nodes: TNode[]; at: number } {
  const alex = tnode("alex", "alex@example.com", "m0");
  const { team, create } = createTeam(alex);
  const core = makeCore(alex, team, cleanups, { limits: { ...DEFAULT_LIMITS, status: { capacity: 100_000, perSecond: 100_000 } } });
  expect(core.ingest(create, "local").status).toBe("accepted");
  const nodes = [alex, ...[1, 2, 3, 4, 5].map((i) => tnode("alex", "alex@example.com", `m${i}`))];
  for (const n of nodes.slice(1)) expect(core.ingest(nodeEv(team, alex, n), "local").status).toBe("accepted");
  const t0 = now();
  for (const n of nodes) {
    for (let i = 0; i < per; i++) {
      // Machine m5's agents are the OLDEST: a global newest-first cut drops them first.
      const ts = t0 - (nodes.length - nodes.indexOf(n)) * 100_000_000 + i * 1000;
      const e = ev(team, n, "agent.status", { agent: `a${i}`, state: "idle", runtime: "claude-code", title: `task ${n.hostname}-${i}` }, { agent: `a${i}`, ts });
      expect(core.ingest(e, n === alex ? "local" : "remote").status).toBe("accepted");
    }
  }
  return { core, team, nodes, at: t0 + IDLE_ARCHIVE_MS };
}

describe("archive paging (Codex 6 / Opus 10)", () => {
  test("six machines × 200: a machine's archive is complete however old it is; total / offset / truncated", () => {
    const { core, at } = sixMachines(200);
    const all = agentsPayload(core, onlineSync, { scope: "archive" }, at);
    expect(all.agents).toHaveLength(1_000);
    expect(all).toMatchObject({ total: 1_200, offset: 0, truncated: true });
    const m5 = agentsPayload(core, onlineSync, { scope: "archive", node: "m5" }, at);
    expect(m5.agents).toHaveLength(200); // filtered before the page: 0 before the fix
    expect(m5).toMatchObject({ total: 200, truncated: false });
    const q = agentsPayload(core, onlineSync, { scope: "archive", q: "m0-19" }, at);
    expect(q.agents.map((a) => a.status.title)).toEqual(["task m0-199", "task m0-198", "task m0-197", "task m0-196", "task m0-195", "task m0-194", "task m0-193", "task m0-192", "task m0-191", "task m0-190", "task m0-19"]);
    const page2 = agentsPayload(core, onlineSync, { scope: "archive", limit: 500, offset: 1_000 }, at);
    expect(page2).toMatchObject({ total: 1_200, offset: 1_000, truncated: false });
    expect(page2.agents).toHaveLength(200);
    const ids = new Set([...all.agents, ...page2.agents].map((a) => a.id));
    expect(ids.size).toBe(1_200); // pages don't overlap
    expect(agentsPayload(core, onlineSync, { scope: "all", states: ["offline"] }, at).total).toBe(0);
    expect(agentsPayload(core, onlineSync, { scope: "all", states: ["idle"] }, at).total).toBe(1_200);
  });
});

describe("archive revision (Codex 7)", () => {
  test("an agent aging into a full archive while the cap drops another: same counts, new revision", () => {
    const alex = tnode("alex");
    const { team, create } = createTeam(alex);
    const clock = { t: now() };
    const core = makeCore(alex, team, cleanups, { clock: () => clock.t, limits: { ...DEFAULT_LIMITS, status: { capacity: 100_000, perSecond: 100_000 } } });
    expect(core.ingest(create, "local").status).toBe("accepted");
    const t0 = clock.t;
    for (let i = 0; i < 4; i++) { clock.t = t0 + i * 1000; core.emit("agent.status", { agent: `old-${i}`, state: "idle", runtime: "claude-code" }, { agent: `old-${i}` }); }
    clock.t = t0 + 10 * 60_000;
    core.emit("agent.status", { agent: "newer", state: "idle", runtime: "claude-code" }, { agent: "newer" });
    const upkeep = new AgentArchive(core, onlineSync, createLogger({}), { cap: 4, now: () => clock.t });
    clock.t = t0 + IDLE_ARCHIVE_MS + 5_000; // the four old ones archived; "newer" still live
    upkeep.tick();
    const before = agentsPayload(core, onlineSync, {}, clock.t);
    expect(before.archive).toEqual([{ node: core.nodeId, idle: 4, offline: 0 }]);
    clock.t = t0 + 10 * 60_000 + IDLE_ARCHIVE_MS + 1; // "newer" ages in; the cap drops old-0
    upkeep.tick();
    const after = agentsPayload(core, onlineSync, {}, clock.t);
    expect(after.archive).toEqual(before.archive); // counts unchanged...
    expect(after.archive_rev).not.toBe(before.archive_rev); // ...contents changed
    expect(agentsPayload(core, onlineSync, { scope: "archive" }, clock.t).agents.map((a) => a.agent)).toContain("newer");
    upkeep.tick();
    expect(agentsPayload(core, onlineSync, {}, clock.t).archive_rev).toBe(after.archive_rev); // nothing moved
  });
});

// ---- a daemon from before MISSION-1 (Codex 8) -----------------------------------------------------------------------

const TEAM = {
  id: "t-legacy", name: "acme", authority: null, plan: null, channels: [],
  members: [{ handle: "alex", role: "owner" }],
  nodes: [{ node_id: "n1", handle: "alex", hostname: "mbp", online: true, self: true, authority: true, rtt_ms: null, last_seen: null, sync: { behind: 0, last_sync: null }, stats: null }],
};
const legacyAgent = (agent: string, state: string, ago: number) => ({
  id: `alex/mbp/${agent}`, handle: "alex", node: "n1", hostname: "mbp", agent, machine_online: true, effective_state: state,
  updated_at: Date.now() - ago, status: { agent, state, runtime: "claude-code", title: `${agent} title` },
});
const LEGACY_AGENTS = { agents: [legacyAgent("busy", "working", 1_000), legacyAgent("resting", "idle", 60_000), legacyAgent("gone", "offline", 3_600_000)] };

async function cli(socket: string, args: string[]) {
  // A person's terminal (no agent runtime among its ancestors).
  return runAsPerson([process.execPath, CLI, ...args], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: "/nonexistent-walkie-home", WALKIE_SOCKET: socket });
}

describe("new CLI and MCP against a pre-MISSION daemon (no archive field)", () => {
  test("the client normalizes the reply once: archive [] and total", async () => {
    const d = fakeDaemon({ "GET /v1/agents": LEGACY_AGENTS, "GET /v1/team": TEAM });
    cleanups.push(d.stop);
    const r = await new WalkieClient({ socket: d.socket }).agents();
    expect(r.archive).toEqual([]);
    expect(r.total).toBe(3);
    expect(r.agents.every((a) => a.archived === false)).toBe(true);
  });

  test("walkie who / who --json / who --all / agents archive work (they threw 'archive is not iterable')", async () => {
    const d = fakeDaemon({ "GET /v1/agents": LEGACY_AGENTS, "GET /v1/team": TEAM });
    cleanups.push(d.stop);
    const who = await cli(d.socket, ["who"]);
    expect(who.err).toBe("");
    expect(who.code).toBe(0);
    expect(who.out).toMatch(/busy\s+working/);
    expect(who.out).not.toContain("resting");
    expect(who.out).toContain("1 idle · 1 offline in the archive");
    const json = JSON.parse((await cli(d.socket, ["who", "--json"])).out) as { agents: unknown[]; hidden: unknown[] };
    expect(json.agents).toHaveLength(1);
    expect(json.hidden).toEqual([{ node: "n1", idle: 1, offline: 1 }]);
    const all = await cli(d.socket, ["who", "--all"]);
    expect(all.code).toBe(0);
    expect(all.out).toContain("resting");
    const arch = JSON.parse((await cli(d.socket, ["agents", "archive", "--json", "--machine", "mbp"])).out) as { agents: Array<{ agent: string }>; total: number };
    expect(arch.agents.map((a) => a.agent)).toEqual(["resting", "gone"]);
    expect(arch.total).toBe(2);
  });

  test("MCP walkie_who (and all: true)", async () => {
    const d = fakeDaemon({ "GET /v1/agents": LEGACY_AGENTS, "GET /v1/team": TEAM });
    cleanups.push(d.stop);
    const client = new WalkieClient({ socket: d.socket, agent: "cc-test01" });
    const res = await callTool(client, "walkie_who", {}) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("busy");
    expect(res.content[0]?.text).toContain("1 idle · 1 offline not listed");
    const all = await callTool(client, "walkie_who", { all: true }) as { content: Array<{ text: string }> };
    expect(all.content[0]?.text).toContain("gone");
  });
});

describe("truncation is reported (Opus 10)", () => {
  test("who --all and agents archive say how many more there are", async () => {
    const page = { agents: [legacyAgent("resting", "idle", 60_000)], archive: [], total: 1_234, offset: 0, truncated: true, archive_rev: 3 };
    const d = fakeDaemon({ "GET /v1/agents": page, "GET /v1/team": TEAM });
    cleanups.push(d.stop);
    const all = await cli(d.socket, ["who", "--all"]);
    expect(all.out).toContain("… 1233 older agents not listed");
    const allJson = JSON.parse((await cli(d.socket, ["who", "--all", "--json"])).out) as { total: number; truncated: boolean };
    expect(allJson).toMatchObject({ total: 1_234, truncated: true });
    const arch = await cli(d.socket, ["agents", "archive", "--limit", "1"]);
    expect(arch.out).toContain("… 1233 more (use --offset 1");
    const q = d.requests.find((r) => r.path.startsWith("/v1/agents?") && /limit=1(&|$)/.test(r.path));
    expect(q?.path).toContain("states=idle%2Coffline");
    const m = await cli(d.socket, ["agents", "archive", "--machine", "mbp", "--search", "x y"]);
    expect(m.code).toBe(0);
    expect(d.requests.at(-1)?.path).toMatch(/node=mbp.*q=x\+y/);
  });

  test(`the archive cap is ${ARCHIVE_CAP_PER_NODE} per machine`, () => {
    expect(ARCHIVE_CAP_PER_NODE).toBe(200);
  });
});
