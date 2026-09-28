// FO-6 board steward end to end on a two-machine team (alex owner + roster authority, bob member): the steward signs
// its moves as the reserved `steward` agent, moves a person's card with an evidence comment, bob's fold agrees, a dry
// run writes nothing, a person's move pins the card, the per-project switch stops it, only a steward machine may run
// it, nobody can speak as `steward`, the CLI prints the plan, and the loop runs when this machine's person turns it on.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WalkieClient, WalkieError } from "../../src/client/index.ts";
import type { CardView, ProjectView } from "../../src/protocol/projects/schema.ts";
import { STEWARD_AGENT } from "../../src/protocol/projects/steward.ts";
import type { RunResult } from "../../src/daemon/projects/steward-run.ts";
import { blockingPeer, runSteward, STEWARD_MIN_VERSION, StewardLoop, stewardConfig, type StewardDeps } from "../../src/daemon/projects/steward-run.ts";
import { nodesView } from "../../src/daemon/views.ts";
import { saveConfigField } from "../../src/daemon/config.ts";
import { Cluster, TEST_LIMITS, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
async function walkie(node: TestNode, args: string[]) {
  return runAsPerson([process.execPath, CLI, ...args], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket });
}

let c: Cluster;
let alex: TestNode, bob: TestNode;
let proj: ProjectView;

const agentOf = (n: TestNode, agent: string) => new WalkieClient({ socket: n.socket, agent, timeoutMs: 15_000 });
const run = (n: TestNode, body: Record<string, unknown>) => n.client().request<RunResult>("POST", "/v1/steward/run", { project: proj.channel, ...body }, 60_000);
const card = async (n: TestNode, id: string): Promise<CardView> => { n.d.projects.flushAll(); return (await n.client().task(id)).card; };
const deps = (n: TestNode, extra: Partial<StewardDeps> = {}): StewardDeps => ({
  core: n.d.core, idx: n.d.projects, sync: n.d.sync, client: n.d.client, catchUp: n.d.sync.requestCatchUp, ...extra,
});
/** A person's run with all peers considered capable; the real version gate is tested separately. */
const runCap = (opts: { dryRun: boolean }, extra: Partial<StewardDeps> = {}) => runSteward(deps(alex, { peersCapable: () => null, ...extra }), proj.channel, { caller: "person", ...opts });

beforeAll(async () => {
  c = new Cluster();
  // Machine stats on: each machine reports its Walkie version, which gates moves of a person's card (fold 9).
  // The steward's writes draw on the agent write limit: widened so the suite's many runs aren't deferred.
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", machineStats: { intervalMs: 500 }, limits: { ...TEST_LIMITS, agentWrite: { capacity: 80, perSecond: 1 } } });
  bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bobs-mbp", machineStats: { intervalMs: 500 } });
  await alex.client().init("aka", "alex");
  await alex.client().invite("bob@example.com", "bob", "member");
  expect((await bob.client().join(alex.peerAddr)).admitted).toBe(true);
  proj = (await alex.client().createProject({ name: "Steward demo", prefix: "SD" })).project;
  await waitFor(async () => { bob.d.projects.flushAll(); return (await bob.client().projects()).projects.some((p) => p.channel === proj.channel); }, { timeoutMs: 10_000, what: "bob sees the project" });
  await waitFor(() => nodesView(alex.d.core, alex.d.sync).find((n) => n.hostname === "bobs-mbp")?.stats?.sys?.version || null, { timeoutMs: 20_000, what: "alex sees bob's version" });
}, 60_000);

afterAll(async () => { await c.close(); });

describe("the board steward", () => {
  let mine: CardView;

  test("a dry run plans the move and writes nothing", async () => {
    mine = (await alex.client().createTask({ project: "SD", title: "LANE-1: build the thing", assignee: "@alex" })).task;
    expect(mine.column).toBe("todo");
    await agentOf(alex, "cc-build").status({ agent: "cc-build", state: "working", runtime: "claude-code", title: "LANE-1 builder" }, { title: "agent" });
    const before = (await alex.client().events({ channel: proj.channel, kinds: "msg.post", limit: 500 })).events.length;
    const r = await runCap({ dryRun: true });
    expect(r.plan.moves.map((m) => [m.key, m.rule, m.from, m.to])).toEqual([[mine.key, "doing", "todo", "doing"]]);
    expect(r.plan.moves[0]?.evidence[0]).toContain("@alex/alex-mbp/cc-build");
    expect((await alex.client().events({ channel: proj.channel, kinds: "msg.post", limit: 500 })).events.length).toBe(before);
    expect((await card(alex, mine.id)).column).toBe("todo");
  });

  test("the real version gate: through the API, a pre.5 peer holds a move of a person's card", async () => {
    const peerState = alex.d.sync.peerState;
    alex.d.sync.peerState = (nodeId) => {
      const state = peerState.call(alex.d.sync, nodeId);
      return nodeId === bob.d.nodeId && state?.stats?.sys
        ? { ...state, stats: { ...state.stats, sys: { ...state.stats.sys, version: "0.2.0-pre.5" } } }
        : state;
    };
    try {
      const reason = `waiting for bobs-mbp to upgrade (it runs Walkie 0.2.0-pre.5; this needs ${STEWARD_MIN_VERSION})`;
      const r = await run(alex, {});
      expect(r.applied).toEqual([]);
      expect(r.plan.held.find((h) => h.card === mine.id)?.reason).toBe(`${reason} (a move of a person's card)`);
      const nodes = nodesView(alex.d.core, alex.d.sync).map((n) => ({ hostname: n.hostname, self: n.self, online: n.online, last_seen: n.last_seen, ...(n.stats?.sys?.version ? { version: n.stats.sys.version } : {}) }));
      expect(blockingPeer(nodes, Date.now())).toBe(reason);
      expect((await card(alex, mine.id)).column).toBe("todo");
    } finally {
      alex.d.sync.peerState = peerState;
    }
  });

  test("a run moves a person's card as `steward`, with an evidence comment; bob's fold agrees", async () => {
    const r = await runCap({ dryRun: false });
    expect(r.applied).toEqual([mine.key]);
    const d = await alex.client().task(mine.id);
    expect(d.card.column).toBe("doing");
    const op = d.timeline.find((t) => t.kind === "op" && t.author.agent === STEWARD_AGENT);
    expect(op && !op.ignored).toBe(true);
    const note = d.timeline.find((t) => t.kind === "comment" && t.author.agent === STEWARD_AGENT);
    expect(note?.text).toContain("Evidence: agent @alex/alex-mbp/cc-build is working on it");
    await waitFor(async () => (await card(bob, mine.id)).column === "doing" || null, { timeoutMs: 10_000, what: "bob folds the steward's move" });
    // Nothing left to do: the plan is empty now.
    expect((await runCap({ dryRun: true })).plan.moves).toEqual([]);
  });

  test("a person's move wins and pins the card against the steward", async () => {
    await alex.client().updateTask(mine.id, { column: "todo" });
    const r = await runCap({ dryRun: false });
    expect(r.applied).toEqual([]);
    expect(r.plan.held.map((h) => h.key)).toEqual([mine.key]);
    expect((await card(alex, mine.id)).column).toBe("todo");
  });

  test("the per-project switch: off refuses a run (a dry run still plans); only a project admin person sets it", async () => {
    const other = (await alex.client().createTask({ project: "SD", title: "LANE-2: other thing" })).task;
    await agentOf(alex, "cc-two").status({ agent: "cc-two", state: "working", runtime: "claude-code", title: "LANE-2 builder" }, { title: "agent" });
    await expect(agentOf(alex, "cc-two").request("POST", `/v1/projects/${proj.channel}`, { steward: "off" })).rejects.toThrow(/people only/);
    await alex.client().request("POST", `/v1/projects/${proj.channel}`, { steward: "off" });
    await expect(run(alex, {})).rejects.toMatchObject({ code: "steward_off" });
    expect((await run(alex, { dry_run: true })).plan.moves.map((m) => m.key)).toEqual([other.key]);
    await alex.client().request("POST", `/v1/projects/${proj.channel}`, { steward: "on" });
    expect((await run(alex, {})).applied).toEqual([other.key]);
  });

  test("only a steward machine runs it (bob is neither an owner nor the creator), and nobody can speak as `steward`", async () => {
    await waitFor(async () => { bob.d.projects.flushAll(); return (await bob.client().projects()).projects.some((p) => p.channel === proj.channel) || null; }, { timeoutMs: 5_000, what: "synced" });
    await expect(run(bob, {})).rejects.toMatchObject({ status: 403 });
    expect(Array.isArray((await run(bob, { dry_run: true })).plan.moves)).toBe(true);
    const fake = agentOf(alex, STEWARD_AGENT);
    await expect(fake.post({ channel: proj.channel, text: "hi" })).rejects.toMatchObject({ status: 403 });
    await expect(alex.client().status({ agent: STEWARD_AGENT, state: "working", runtime: "claude-code" })).rejects.toBeInstanceOf(WalkieError);
  });

  test("the CLI prints the plan", async () => {
    await alex.client().createTask({ project: "SD", title: "LANE-3: third" });
    await agentOf(alex, "cc-three").status({ agent: "cc-three", state: "working", runtime: "claude-code", title: "LANE-3 builder" }, { title: "agent" });
    const out = await walkie(alex, ["board", "steward", "run", "--project", "SD", "--dry-run"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain("DRY RUN");
    expect(out.out).toMatch(/SD-\d+ \[doing\] todo -> doing/);
    const json = await walkie(alex, ["board", "steward", "run", "--project", "SD", "--dry-run", "--json"]);
    expect((JSON.parse(json.out) as RunResult).plan.moves.length).toBe(1);
  });

  test("the loop runs only when this machine's person turned it on AND holds the project's lease", async () => {
    const loop = new StewardLoop(deps(alex));
    try {
      expect(await loop.tick()).toEqual([]);
      await expect(agentOf(alex, "cc-x").request("POST", "/v1/steward/config", { auto: true })).rejects.toThrow(/people only/);
      await alex.client().request("POST", "/v1/steward/config", { auto: true });
      expect(await loop.tick()).toEqual([]); // on, but no lease: another machine may keep this board
      const out = await walkie(alex, ["board", "steward", "auto", "on", "--project", "SD"]);
      expect(out.code).toBe(0);
      alex.d.projects.flushAll();
      expect((await alex.client().project(proj.channel)).project.steward_node).toBe(alex.d.nodeId);
      const moved = await loop.tick();
      expect(moved.length).toBe(1);
      expect(moved[0]).toMatch(/^SD:SD-\d+$/);
    } finally {
      loop.stop();
    }
  });

  test("upgrading keeps an auto loop running: a config from before the lease takes the lease once (round 3)", async () => {
    await alex.client().request("POST", `/v1/projects/${proj.channel}`, { steward_node: "" });
    saveConfigField(alex.d.core.paths.config, "steward", { auto: true, interval_min: 15, stale_hours: 24 });
    const loop = new StewardLoop(deps(alex));
    try {
      await loop.tick();
      alex.d.projects.flushAll();
      expect((await alex.client().project(proj.channel)).project.steward_node).toBe(alex.d.nodeId);
      expect(stewardConfig(alex.d.core).lease_migrated).toBe(true);
      // A person releasing the lease afterwards is not undone by the migration.
      await alex.client().request("POST", `/v1/projects/${proj.channel}`, { steward_node: "" });
      await loop.tick();
      alex.d.projects.flushAll();
      expect((await alex.client().project(proj.channel)).project.steward_node).toBe("");
    } finally {
      loop.stop();
      await alex.client().request("POST", "/v1/steward/config", { auto: false });
    }
  });

  test("an agent may only dry-run; a member's agent's comment or status is no evidence on alex's card (Opus A1, A3)", async () => {
    await alex.client().request("POST", `/v1/projects/${proj.channel}`, { automations: { agents_can_close: false } });
    const t = (await alex.client().createTask({ project: "SD", title: "Private plan for alex", assignee: "@alex", column: "backlog" })).task;
    await expect(agentOf(alex, "cc-evil").request("POST", "/v1/steward/run", { project: proj.channel }, 60_000)).rejects.toMatchObject({ status: 403 });
    expect(Array.isArray((await agentOf(alex, "cc-evil").request<RunResult>("POST", "/v1/steward/run", { project: proj.channel, dry_run: true }, 60_000)).plan.moves)).toBe(true);
    await waitFor(async () => { bob.d.projects.flushAll(); try { await bob.client().task(t.id); return true; } catch { return null; } }, { timeoutMs: 10_000, what: "bob sees the card" });
    await agentOf(bob, "bob-agent").request("POST", `/v1/tasks/${t.id}/comment`, { text: "done" });
    const own = (await alex.client().createTask({ project: "SD", title: "OWN-77: alex personal", assignee: "@alex", column: "backlog" })).task;
    await agentOf(bob, "bob-x").status({ agent: "bob-x", state: "working", runtime: "claude-code", title: `whatever ${own.key}` }, { title: "agent" });
    await waitFor(async () => { alex.d.projects.flushAll(); return (await alex.client().task(t.id)).timeline.some((x) => x.kind === "comment") || null; }, { timeoutMs: 10_000, what: "the comment reached alex" });
    await waitFor(async () => (await alex.client().request<{ agents: Array<{ agent: string }> }>("GET", "/v1/agents")).agents.some((a) => a.agent === "bob-x") || null, { timeoutMs: 10_000, what: "bob's status reached alex" });
    const r = await runCap({ dryRun: false }); // every machine capable: nothing held back by the gate, refused on trust
    expect(r.plan.moves.filter((m) => m.card === t.id || m.card === own.id)).toEqual([]);
    expect(r.plan.held.filter((h) => h.card === t.id || h.card === own.id)).toEqual([]);
    expect((await card(alex, t.id)).column).toBe("backlog");
    expect((await card(alex, own.id)).column).toBe("backlog");
    await alex.client().request("POST", `/v1/projects/${proj.channel}`, { automations: { agents_can_close: true } });
  });

  test("a move of a person's card waits while a machine runs an older Walkie; one run per project at a time", async () => {
    const t = (await alex.client().createTask({ project: "SD", title: "LANE-9: gated", assignee: "@alex" })).task;
    await agentOf(alex, "cc-nine").status({ agent: "cc-nine", state: "working", runtime: "claude-code", title: "LANE-9 builder" }, { title: "agent" });
    const r = await runSteward(deps(alex, { peersCapable: () => "bobs-mbp runs Walkie 0.2.0-pre.5" }), proj.channel, { dryRun: false });
    expect(r.applied).toEqual([]);
    expect(r.plan.held.find((h) => h.card === t.id)?.reason).toContain("bobs-mbp runs Walkie 0.2.0-pre.5");
    const both = await Promise.allSettled([runSteward(deps(alex), proj.channel, { dryRun: true }), runSteward(deps(alex), proj.channel, { dryRun: true })]);
    expect(both.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((both.find((x) => x.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "steward_busy" });
  });

  test("each write is re-validated against a fresh read: a person's change after the plan cancels the move", async () => {
    const t = (await alex.client().createTask({ project: "SD", title: "LANE-10: raced", assignee: "@alex" })).task;
    await agentOf(alex, "cc-ten").status({ agent: "cc-ten", state: "working", runtime: "claude-code", title: "LANE-10 builder" }, { title: "agent" });
    const r = await runCap({ dryRun: false }, { beforeWrites: async () => { await alex.client().updateTask(t.id, { title: "LANE-10: raced (renamed)" }); } });
    expect(r.applied).not.toContain(t.key);
    expect(r.failed.find((f) => f.key === t.key)?.error).toBe("the card changed since the plan");
    expect((await card(alex, t.id)).column).toBe("todo");
  });

  test("write-time re-checks (Codex r2 MED 3, 4, 6): agents_can_close turned off, the lease moved, and a flag plus a move on one card", async () => {
    // MED 3: a done planned on a comment alone, then a person turns agents_can_close off.
    const said = (await alex.client().createTask({ project: "SD", title: "CLOSE-1: x" })).task;
    await alex.client().request("POST", `/v1/tasks/${said.id}/comment`, { text: "done: shipped" });
    const r1 = await runCap({ dryRun: false }, { beforeWrites: async () => { await alex.client().request("POST", `/v1/projects/${proj.channel}`, { automations: { agents_can_close: false } }); } });
    expect(r1.failed.find((f) => f.key === said.key)?.error).toBe("agents_can_close was turned off: a person closes it");
    await alex.client().request("POST", `/v1/projects/${proj.channel}`, { automations: { agents_can_close: true } });
    // MED 4: a loop run under a lease the person moves away meanwhile writes nothing.
    await alex.client().request("POST", `/v1/projects/${proj.channel}`, { steward_node: alex.d.nodeId });
    const r2 = await runSteward(deps(alex, { peersCapable: () => null, beforeWrites: async () => { await alex.client().request("POST", `/v1/projects/${proj.channel}`, { steward_node: "" }); } }), proj.channel, { dryRun: false, caller: "loop", lease: alex.d.nodeId });
    expect(r2.applied).toEqual([]);
    expect(r2.failed.find((f) => f.key === said.key)?.error).toBe("the project's steward lease moved to another machine");
    // MED 6: the newer of two same-title cards is flagged AND closed in one run: the flag's comment doesn't void the move.
    const keep = (await alex.client().createTask({ project: "SD", title: "TWIN-1: same" })).task;
    const twin = (await alex.client().createTask({ project: "SD", title: "TWIN-1: same" })).task;
    await alex.client().request("POST", `/v1/tasks/${twin.id}/comment`, { text: "done" });
    const r3 = await runCap({ dryRun: false });
    expect(r3.plan.deferred).toBe(0);
    expect(r3.plan.moves.filter((m) => m.card === twin.id).map((m) => m.rule).sort()).toEqual(["done", "duplicate"]);
    expect(r3.failed.filter((f) => f.key === twin.key)).toEqual([]);
    expect((await card(alex, twin.id)).column).toBe("done");
    expect((await alex.client().task(keep.id)).timeline.some((e) => e.kind === "comment" && e.author.agent === STEWARD_AGENT)).toBe(true);
  });

  test("agents' dry runs have their own budget: exhausting it leaves people's runs alone (round 3)", async () => {
    const agent = agentOf(alex, "cc-spam");
    let limited = 0;
    for (let i = 0; i < 120 && !limited; i++) {
      try { await agent.request("POST", "/v1/steward/run", { project: proj.channel, dry_run: true }, 60_000); } catch (e) { if ((e as WalkieError).status === 429) limited++; else throw e; }
    }
    expect(limited).toBe(1);
    expect(Array.isArray((await run(alex, { dry_run: true })).plan.moves)).toBe(true);
  });
  test("fold 10: a lease already folded under fold 9 is re-read on upgrade (Codex r2 MED 7)", async () => {
    await alex.client().request("POST", `/v1/projects/${proj.channel}`, { steward_node: alex.d.nodeId });
    const idx = alex.d.projects;
    idx.flushAll();
    // What a fold-9 daemon stored: the view without the field, and its fold version.
    const { steward_node: _gone, ...old } = idx.project(proj.channel) as ProjectView;
    idx.db.saveProject(proj.channel, old.id, JSON.stringify(old), old.last_activity);
    alex.d.core.store.setMeta("projects_fold", "9");
    expect(idx.project(proj.channel)?.steward_node).toBeUndefined();
    idx.start();
    idx.flushAll();
    expect(idx.project(proj.channel)?.steward_node).toBe(alex.d.nodeId);
  });
});
