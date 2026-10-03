// DAEMON-STALL-2: with a team's thousands of agent records the daemon's work per tick stays bounded. A roster read costs
// allocation only for the agents that changed (the rest hand back the same view objects), the stream re-serialises only
// those, the agent table is read from memory, the seats view and the sub-agent cap look at their own rows only, and the
// archive's retention drops a record only for its own status, never for a machine that merely looks offline.
// Deterministic: work is counted (rows parsed, views built, JSON texts made), never timed.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentArchive, archiveOverflow, overdueHiddenRows } from "../../src/daemon/agent-archive.ts";
import { agentStatus } from "../../src/daemon/agent-table.ts";
import { agentRowView, agentViewCache } from "../../src/daemon/agent-view-cache.ts";
import type { Core } from "../../src/daemon/core.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { flushDelay, Hub, LOAD_FACTOR, MAX_FLUSH_DELAY_MS } from "../../src/daemon/sse.ts";
import { seatHosts } from "../../src/daemon/seats/view.ts";
import { Store } from "../../src/daemon/store.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { agentsPayload, agentsView, liveSubagents } from "../../src/daemon/views.ts";
import type { SinceInput } from "../../src/protocol/agent-since.ts";
import { effectiveState, observedAt } from "../../src/daemon/agent-state.ts";
import { ARCHIVE_CAP_PER_NODE, ARCHIVE_TTL_MS, IDLE_ARCHIVE_MS, isArchivedAt, OFFLINE_GRACE_MS } from "../../src/protocol/agent-roster.ts";
import type { AgentState, AgentView, BodyOf, Event, StreamMessage } from "../../src/protocol/schemas.ts";
import { cloudAddress, isCloudAgent } from "../../src/protocol/guest-cloud.ts";
import { countSubagents, CUSTOM_SUBAGENT_TYPE, SUBAGENT_ARCHIVE_CAP_PER_NODE } from "../../src/protocol/subagents.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, memberEv, nodeEv, now as helperNow, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

type Status = BodyOf<"agent.status">;
const MIN = 60_000;

/** Which machines the daemon reaches (everything online unless listed). */
class FakeSync {
  readonly offline = new Set<string>();
  isOnline = (node: string): boolean => !this.offline.has(node);
}

interface World {
  core: Core; sync: FakeSync; clock: { t: number };
  /** [0] is this machine; kira has two machines that share a hostname (so their agents share display ids). */
  nodes: TNode[];
  /** Puts an agent's latest status in the table the way a received event does. */
  put(node: TNode, agent: string, body?: Partial<Status>, ts?: number): void;
  seq: number;
}

function world(): World {
  const alex = tnode("alex");
  const kira = tnode("kira", undefined, "kira-mbp");
  const kira2 = tnode("kira", undefined, "kira-mbp");
  const sam = tnode("sam");
  const lee = tnode("lee");
  const { team, create } = createTeam(alex);
  const clock = { t: helperNow() };
  const core = makeCore(alex, team, cleanups, { clock: () => clock.t });
  expect(core.ingest(create, "local").status).toBe("accepted");
  for (const who of [kira, sam, lee]) {
    expect(core.ingest(memberEv(team, alex, who, "member"), "local").status).toBe("accepted");
    expect(core.ingest(nodeEv(team, alex, who), "local").status).toBe("accepted");
  }
  expect(core.ingest(nodeEv(team, alex, kira2), "local").status).toBe("accepted");
  const w: World = {
    core, sync: new FakeSync(), clock, nodes: [alex, kira, kira2, sam, lee], seq: 1_000,
    put(node, agent, body = {}, ts = clock.t) {
      w.seq += 1;
      const ev = {
        id: `${node.keys.nodeId}:${w.seq}`, origin: node.keys.nodeId, seq: w.seq, ts, kind: "agent.status",
        author: { handle: node.handle, node: node.keys.nodeId }, body: { agent, state: "idle", runtime: "claude-code", ...body }, sig: "s",
      };
      core.store.upsertAgent(ev as unknown as Event);
    },
  };
  return w;
}

/** Polls `cond` until it holds (a timer fired late on a loaded machine is not a failure). */
async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  for (const stop = Date.now() + ms; !cond() && Date.now() < stop;) await Bun.sleep(5);
}

const asSync = (w: World): SyncManager => w.sync as unknown as SyncManager;
const views = (w: World, now = w.clock.t): AgentView[] => agentsView(w.core, asSync(w), now);
const counters = (w: World) => ({ ...agentViewCache(w.core).counters });
const delta = (w: World, before: ReturnType<typeof counters>) => {
  const c = counters(w);
  return { parsed: c.parsed - before.parsed, based: c.based - before.based, finals: c.finals - before.finals };
};

/** `n` agents spread over the five machines: ~5% working now, the rest idle or offline for days (the long-dead records). */
function populate(w: World, n: number): void {
  for (let i = 0; i < n; i++) {
    const node = w.nodes[i % w.nodes.length] as TNode;
    if (i % 20 === 0) w.put(node, `cc-live-${i}`, { state: "working", activity: "Running a command", title: `Task ${i}` }, w.clock.t - 30_000);
    else w.put(node, `cc-old-${i}`, { state: i % 3 === 0 ? "offline" : "idle", title: `Old ${i}` }, w.clock.t - 3 * 86_400_000 - i * 1_000);
  }
}

describe("the roster read does work for the agents that changed, not for all of them", () => {
  test("2,000 agents: the first read parses and builds each once, the next ones nothing, and hand back the same views", () => {
    const w = world();
    populate(w, 2_000);
    const before = counters(w);
    const first = views(w);
    expect(first).toHaveLength(2_000);
    expect(delta(w, before)).toEqual({ parsed: 2_000, based: 2_000, finals: 2_000 });
    const mid = counters(w);
    const second = views(w);
    expect(delta(w, mid)).toEqual({ parsed: 0, based: 0, finals: 0 });
    expect(second).not.toBe(first); // a new array each read…
    expect(second.every((v, i) => v === first[i])).toBe(true); // …of the same view objects
    expect(agentsPayload(w.core, asSync(w), {}, w.clock.t).agents.every((v) => first.includes(v))).toBe(true);
  });

  test("one agent reporting costs one parse and one view; every other view is untouched", () => {
    const w = world();
    populate(w, 2_000);
    const first = views(w);
    w.clock.t += 5_000;
    const victim = first.find((v) => v.agent === "cc-live-40") as AgentView;
    const owner = w.nodes.find((n) => n.keys.nodeId === victim.node) as TNode;
    w.put(owner, "cc-live-40", { state: "working", activity: "Editing files", title: "Task 40" }, w.clock.t);
    const before = counters(w);
    const second = views(w);
    expect(delta(w, before)).toEqual({ parsed: 1, based: 1, finals: 1 });
    const changed = second.filter((v, i) => v !== first[i]);
    expect(changed.map((v) => v.agent)).toEqual(["cc-live-40"]);
    expect(changed[0]?.status.activity).toBe("Editing files");
  });

  test("time passing moves only the agents that crossed a threshold", () => {
    const w = world();
    const node = w.nodes[0] as TNode;
    populate(w, 1_000);
    // 10 idle agents that turn 30 minutes old (archived) in the next two seconds, 10 that don't.
    for (let i = 0; i < 10; i++) w.put(node, `edge-${i}`, { state: "idle" }, w.clock.t - IDLE_ARCHIVE_MS + 1_000);
    for (let i = 0; i < 10; i++) w.put(node, `calm-${i}`, { state: "idle" }, w.clock.t - 5 * MIN);
    const first = views(w);
    expect(first.filter((v) => v.agent.startsWith("edge-")).every((v) => !v.archived)).toBe(true);
    const before = counters(w);
    const second = views(w, w.clock.t + 2_000);
    expect(delta(w, before)).toEqual({ parsed: 0, based: 10, finals: 10 });
    const changed = second.filter((v, i) => v !== first[i]);
    expect(changed.map((v) => v.agent).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `edge-${i}`).sort());
    expect(changed.every((v) => v.archived)).toBe(true);
  });

  test("a machine going offline and coming back rebuilds only that machine's agents", () => {
    const w = world();
    populate(w, 1_000);
    const first = views(w);
    const node = w.nodes[3] as TNode;
    const mine = first.filter((v) => v.node === node.keys.nodeId).length;
    expect(mine).toBe(200);
    w.sync.offline.add(node.keys.nodeId);
    let before = counters(w);
    const down = views(w);
    // Only the rows whose answer changes are rebuilt (an agent already offline stays as it was) and nothing is parsed again.
    const flipped = down.filter((v, i) => v !== first[i]);
    expect(flipped.length).toBeGreaterThan(0);
    expect(flipped.every((v) => v.node === node.keys.nodeId && !v.machine_online)).toBe(true);
    expect(delta(w, before)).toEqual({ parsed: 0, based: flipped.length, finals: flipped.length });
    w.sync.offline.delete(node.keys.nodeId);
    before = counters(w);
    const up = views(w);
    expect(up.map((v) => v.machine_online)).toEqual(first.map((v) => v.machine_online));
    expect(delta(w, before)).toEqual({ parsed: 0, based: flipped.length, finals: flipped.length });
    // Everything but the starts of the time-in-state (a flip with nothing newer behind it starts at now) is as it was.
    const bare = (v: AgentView) => { const { state_since: _s, activity_since: _a, ...rest } = v; return rest; };
    expect(up.map(bare)).toEqual(first.map(bare));
  });

  test("agents that left the table (or the roster) leave the cache with them", () => {
    const w = world();
    populate(w, 200);
    expect(views(w)).toHaveLength(200);
    const gone = w.core.store.agents().slice(0, 50);
    w.core.store.deleteAgents(gone);
    expect(views(w)).toHaveLength(150);
    // The cache did not keep what is gone: reading them again (a new status) is a first read for each.
    const before = counters(w);
    for (const row of gone.slice(0, 3)) w.put(w.nodes.find((n) => n.keys.nodeId === row.node) as TNode, row.agent, {}, w.clock.t);
    views(w);
    expect(delta(w, before).parsed).toBe(3);
  });
});

/** The roster read as it was built before DAEMON-STALL-2 (rawAgentsView + withSince + agentsView), verbatim. */
class ReferenceSince {
  private seen = new Map<string, { state: AgentState; stateSince: number; line: string; lineSince: number; observed: number }>();
  read(rows: readonly SinceInput[], now: number) {
    const next = new Map<string, { state: AgentState; stateSince: number; line: string; lineSince: number; observed: number }>();
    const out = new Map<string, { state_since: number; activity_since: number }>();
    for (const r of rows) {
      const prev = this.seen.get(r.id);
      const line = `${r.effective_state}\n${r.activity ?? ""}`;
      const start = prev && r.observed <= prev.observed ? now : Math.min(r.observed, now);
      const s = {
        state: r.effective_state, line, observed: Math.max(r.observed, prev?.observed ?? 0),
        stateSince: prev && prev.state === r.effective_state ? prev.stateSince : start,
        lineSince: prev && prev.line === line ? prev.lineSince : start,
      };
      next.set(r.id, s);
      out.set(r.id, { state_since: s.stateSince, activity_since: s.lineSince });
    }
    this.seen = next;
    return out;
  }
}

function referenceViews(core: Core, sync: SyncManager, since: ReferenceSince, now: number): AgentView[] {
  const r = core.roster;
  const out: AgentView[] = [];
  const starts = new Map<string, number>();
  for (const row of core.store.agents()) {
    const node = r.nodes.get(row.node);
    if (!node || node.revoked) continue;
    const member = r.members.get(node.login);
    if (!member || member.role === "removed") continue;
    const status = JSON.parse(row.body) as Status;
    const online = sync.isOnline(row.node, now);
    const observed = observedAt(status, row.ts);
    const effective = effectiveState(status.state, observed, online, now);
    const id = isCloudAgent({ agent: row.agent, status }) ? cloudAddress({ handle: member.handle, agent: row.agent })
      : `${member.handle}/${node.hostname}/${row.agent}`;
    out.push({
      id, handle: member.handle, node: row.node, hostname: node.hostname, agent: row.agent,
      status: { ...status, runtime: status.runtime ?? "other" }, updated_at: observed, machine_online: online,
      effective_state: effective, archived: isArchivedAt(effective, observed, now),
    });
    const received = row.node === core.nodeId ? null : core.store.agentReceivedAt(row);
    starts.set(id, received === null ? observed : Math.max(observed, received));
  }
  const s = since.read(out.map((a) => ({ id: a.id, effective_state: a.effective_state, activity: a.status.activity, observed: starts.get(a.id) ?? a.updated_at })), now);
  const timed = out.map((a) => ({ ...a, ...s.get(a.id) }));
  const counts = countSubagents(timed);
  return timed.map((a) => {
    const c = a.status.parent ? undefined : counts.get(`${a.node}/${a.agent}`);
    const own = a.status.parent && a.node === core.nodeId ? core.localSubagents.get(a.agent) : undefined;
    const status = own && ((!a.status.title && own.title) || (a.status.subagent_type === CUSTOM_SUBAGENT_TYPE && own.type))
      ? { ...a.status, ...(!a.status.title && own.title ? { title: own.title } : {}), ...(a.status.subagent_type === CUSTOM_SUBAGENT_TYPE && own.type ? { subagent_type: own.type } : {}) }
      : a.status;
    if (!c && status === a.status) return a;
    return { ...a, status, ...(c ? { subagents: c, archived: a.archived && c.working === 0 } : {}) };
  });
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the cached roster is the roster built from scratch", () => {
  test("random histories (new statuses, sub-agents, deletions, machines going offline, time passing, display ids shared by two machines)", () => {
    for (const seed of [11, 12, 13]) {
      const rand = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
      const w = world();
      const ref = new ReferenceSince();
      const states: AgentState[] = ["working", "idle", "waiting", "blocked", "offline"];
      // (Cloud guests' cards, `dots-*` / `grokbot-*`, are shown under an address of their own; judged on the status as sent.)
      const sessions = [...Array.from({ length: 40 }, (_, i) => `cc-${i}`), "dots-a", "dots-b", "grokbot-a"];
      for (let step = 0; step < 90; step++) {
        for (let k = 0; k < 8; k++) {
          const node = pick(w.nodes);
          const session = pick(sessions);
          const sub = rand() < 0.45;
          const agent = sub ? `${session}.s${Math.floor(rand() * 6)}` : session;
          const row = w.core.store.agent(node.keys.nodeId, agent);
          const ts = Math.max(w.clock.t - Math.floor(rand() * 90 * MIN), (row?.ts ?? 0) + 1);
          w.put(node, agent, {
            state: pick(states), ...(rand() < 0.6 ? { activity: pick(["Running a command", "Editing files", "Reading"]) } : {}),
            ...(rand() < 0.5 ? { title: `t${Math.floor(rand() * 5)}` } : {}),
            ...(sub ? { parent: session, ...(rand() < 0.5 ? { subagent_type: pick(["Explore", CUSTOM_SUBAGENT_TYPE]) } : {}) } : {}),
            ...(rand() < 0.1 ? { observed_at: ts - 1_000 } : {}),
            ...(agent.startsWith("dots-") || agent.startsWith("grokbot-")
              ? { runtime: pick([undefined, "other" as const, "claude-code" as const]), runtime_name: pick(["dots", "grokbot", "other"]) } : {}),
          }, ts);
        }
        if (rand() < 0.3) w.core.store.deleteAgents(w.core.store.agents().filter(() => rand() < 0.02));
        if (rand() < 0.4) {
          const n = pick(w.nodes).keys.nodeId;
          if (w.sync.offline.has(n)) w.sync.offline.delete(n); else w.sync.offline.add(n);
        }
        if (rand() < 0.4) w.core.localSubagents.set(`${pick(sessions)}.s${Math.floor(rand() * 6)}`, { title: "own title", type: "own type" });
        w.clock.t += Math.floor(rand() * 25 * MIN);
        const want = referenceViews(w.core, asSync(w), ref, w.clock.t);
        const got = views(w);
        expect(got.length).toBe(want.length);
        expect(JSON.stringify(got)).toBe(JSON.stringify(want)); // the same values, in the same key order
      }
    }
  });

  test("a view built for one row alone is the roster's view before time-in-state and sub-agent counts", () => {
    const w = world();
    populate(w, 100);
    const all = views(w);
    for (const row of w.core.store.agents().slice(0, 30)) {
      const one = agentRowView(w.core, asSync(w), row, w.clock.t) as AgentView;
      const { state_since: _s, activity_since: _a, ...rest } = all.find((v) => v.node === row.node && v.agent === row.agent) as AgentView;
      expect(one).toEqual(rest);
    }
    expect(agentRowView(w.core, asSync(w), { node: "ffffffffffffffff", agent: "x", handle: "x", event_id: "e", ts: 1, body: "{}" })).toBeNull();
  });
});

describe("the agent table lives in memory and follows every write", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const open = (): Store => {
    const d = mkdtempSync("/tmp/walkie-agent-scale-");
    dirs.push(d);
    return new Store(join(d, "w.db"));
  };
  const fromSql = (s: Store) => s.db.query("SELECT * FROM agents_latest ORDER BY handle, node, agent").all();
  const status = (n: number, agent: string, ts: number, handle = "alex", node = "n1"): Event => ({
    id: `${node}:${n}`, origin: node, seq: n, ts, kind: "agent.status", author: { handle, node }, body: { agent, state: "working", runtime: "claude-code" }, sig: "s",
  } as unknown as Event);

  test("reads equal SQLite's table, in its order, through upserts, deletes, hides and a rolled-back transaction", () => {
    const s = open();
    s.db.query("INSERT INTO agents_latest(node, agent, handle, event_id, ts, body) VALUES ('n2','b-1','sam','n2:1',5,'{}')").run(); // before the first read
    expect(s.agents().map((r) => r.agent)).toEqual(["b-1"]);
    const rand = prng(7);
    for (let i = 2; i < 400; i++) {
      const handle = ["alex", "kira", "sam", "alex-2"][Math.floor(rand() * 4)] as string;
      const node = ["n1", "n2", "n10"][Math.floor(rand() * 3)] as string;
      s.upsertAgent(status(i, `a-${Math.floor(rand() * 60)}`, 10 + i, handle, node));
      if (i % 25 === 0) {
        const rows = s.agents();
        s.deleteAgents(rows.filter(() => rand() < 0.1));
      }
      if (i % 50 === 0) expect(s.agents()).toEqual(fromSql(s) as never);
    }
    expect(s.agents()).toEqual(fromSql(s) as never);
    // A transaction that throws after writing an agent: the table is what SQLite holds.
    const row = s.agents()[0];
    expect(() => s.transaction(() => { s.upsertAgent(status(9_000, "rolled-back", 99_999)); throw new Error("no"); })).toThrow("no");
    expect(s.agent("n1", "rolled-back")).toBeNull();
    expect(s.agents().some((r) => r.agent === "rolled-back")).toBe(false);
    expect(s.agents()).toEqual(fromSql(s) as never);
    expect(s.agents()[0]).toEqual(row as never);
    // recomputeAgent (an event was hidden): the row follows the events.
    s.db.query("INSERT INTO events(id, origin, seq, ts, kind, author_agent, redacted, status, json, received_at) VALUES ('n1:7001','n1',7001,500,'agent.status','a-recomputed',0,'ok',?,600)")
      .run(JSON.stringify(status(7_001, "a-recomputed", 500)));
    s.upsertAgent(status(7_002, "a-recomputed", 900));
    expect(s.agent("n1", "a-recomputed")?.ts).toBe(900);
    s.recomputeAgent("n1", "a-recomputed");
    expect(s.agents().find((r) => r.agent === "a-recomputed")?.ts).toBe(500);
    s.recomputeAgent("n1", "a-unknown");
    expect(s.agents()).toEqual(fromSql(s) as never);
    s.close();
  });

  test("the same array until a row changes, the same row object until its agent reports, and a status parsed once", () => {
    const s = open();
    s.upsertAgent(status(1, "a-1", 10));
    s.upsertAgent(status(2, "a-2", 11));
    const list = s.agents();
    expect(s.agents()).toBe(list);
    const row1 = list.find((r) => r.agent === "a-1");
    const row2 = list.find((r) => r.agent === "a-2");
    expect(agentStatus(row1 as never)).toBe(agentStatus(row1 as never));
    s.upsertAgent(status(3, "a-1", 20));
    const next = s.agents();
    expect(next).not.toBe(list);
    expect(next.find((r) => r.agent === "a-2")).toBe(row2);
    expect(next.find((r) => r.agent === "a-1")).not.toBe(row1);
    s.upsertAgent(status(4, "a-1", 15)); // older than what the row holds: no change, no new array
    expect(s.agents()).toBe(next);
    s.close();
  });
});

describe("the stream re-serialises only the agents that changed, and flushes less often while flushing is slow", () => {
  function reader(res: Response) {
    const r = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const frames: StreamMessage[] = [];
    // A read that loses the race to the timeout stays pending and is awaited by the next pump (never dropped).
    let pending: ReturnType<typeof r.read> | null = null;
    const pump = async (ms: number) => {
      const until = Date.now() + ms;
      for (;;) {
        const left = until - Date.now();
        if (left <= 0) return;
        pending ??= r.read();
        const next = await Promise.race([pending, Bun.sleep(left).then(() => null)]);
        if (next === null) return;
        pending = null;
        if (next.done) return;
        buf += dec.decode(next.value);
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const data = /^data: (.+)$/m.exec(buf.slice(0, i))?.[1];
          buf = buf.slice(i + 2);
          if (data) frames.push(JSON.parse(data) as StreamMessage);
        }
      }
    };
    return { frames, pump };
  }

  test("a flush of a 2,000-agent roster with one agent changed makes one JSON text and sends one row", async () => {
    const w = world();
    populate(w, 2_000);
    const hub = new Hub(60_000, 5);
    cleanups.push(() => hub.close());
    hub.setProviders({ agents: () => agentsPayload(w.core, asSync(w), {}, w.clock.t), nodes: () => [], visible: () => true });
    const ac = new AbortController();
    const c = reader(hub.open(null, [], ac.signal, undefined, { agentsDelta: true }) as Response);
    await c.pump(40);
    const snapshot = c.frames.find((f) => f.type === "agents");
    expect(snapshot?.type === "agents" && snapshot.agents.length).toBe(100); // the 5% that are live
    const live = views(w).find((v) => v.agent === "cc-live-60") as AgentView;
    const owner = w.nodes.find((n) => n.keys.nodeId === live.node) as TNode;
    w.clock.t += 2_000;
    w.put(owner, "cc-live-60", { state: "working", activity: "Editing files", title: "Task 60" }, w.clock.t);
    const real = JSON.stringify;
    let rowTexts = 0;
    JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
      if (typeof value === "object" && value !== null && "effective_state" in value && "machine_online" in value) rowTexts++;
      return (real as (v: unknown, ...r: unknown[]) => string)(value, ...rest);
    }) as typeof JSON.stringify;
    try {
      hub.agentsChanged();
      for (let i = 0; i < 60 && !c.frames.some((f) => f.type === "agents.delta"); i++) await c.pump(50);
    } finally {
      JSON.stringify = real;
    }
    const d = c.frames.find((f) => f.type === "agents.delta");
    expect(d?.type === "agents.delta" && d.upsert.map((a) => a.agent)).toEqual(["cc-live-60"]);
    expect(rowTexts).toBe(1);
    ac.abort();
  });

  test("the wait before the next flush follows how long the last one took, capped", async () => {
    expect(flushDelay(250, 0)).toBe(250);
    expect(flushDelay(250, 10)).toBe(250); // fast: the debounce as before
    expect(flushDelay(250, 100)).toBe(100 * LOAD_FACTOR);
    expect(flushDelay(250, 5_000)).toBe(MAX_FLUSH_DELAY_MS);
    let t = 0;
    let took = 0;
    const hub = new Hub(60_000, 5, () => t);
    cleanups.push(() => hub.close());
    hub.setProviders({ agents: () => { t += took; return { agents: [], archive: [] }; }, nodes: () => [], visible: () => true });
    const ac = new AbortController();
    hub.open(null, [], ac.signal, undefined, { agentsDelta: true });
    expect(hub.agentsFlushDelayMs).toBe(5);
    took = 200; // a slow flush (a machine short of memory)…
    hub.agentsChanged();
    await until(() => hub.agentsFlushDelayMs !== 5);
    expect(hub.agentsFlushDelayMs).toBe(200 * LOAD_FACTOR); // …makes the next one wait four times as long
    took = 0;
    hub.agentsChanged(); // scheduled at the long delay; a fast flush then brings the debounce back
    await until(() => hub.agentsFlushDelayMs === 5);
    expect(hub.agentsFlushDelayMs).toBe(5);
    ac.abort();
  });
});

describe("the seats view and the sub-agent cap do not walk the roster", () => {
  test("GET /v1/seats builds no roster views and gives each machine's seats card as the roster does", () => {
    const w = world();
    populate(w, 2_000);
    for (const n of w.nodes.slice(0, 4)) w.put(n, "seats", { state: "idle", runtime: "other", activity: n === w.nodes[1] ? "Seats on" : undefined } as never, w.clock.t - 5_000);
    w.put(w.nodes[4] as TNode, "seats", { state: "offline" }, w.clock.t - 5_000);
    w.sync.offline.add((w.nodes[3] as TNode).keys.nodeId);
    const before = counters(w);
    const hosts = seatHosts(w.core, asSync(w));
    expect(delta(w, before)).toEqual({ parsed: 0, based: 0, finals: 0 }); // the roster was not read at all
    const cards = agentsView(w.core, asSync(w), w.clock.t).filter((a) => a.agent === "seats");
    expect(hosts.map((h) => h.node).sort()).toEqual(cards.map((a) => a.node).sort());
    for (const h of hosts) {
      const a = cards.find((c) => c.node === h.node) as AgentView;
      expect(h).toMatchObject({ hostname: a.hostname, handle: a.handle, self: a.node === w.core.nodeId, allows: a.status.state !== "offline", online: a.node === w.core.nodeId || w.sync.isOnline(a.node) });
      expect(h.activity).toBe(a.status.activity);
    }
  });

  test("liveSubagents counts this machine's live sub-agents of a session as before, and reads no JSON the second time", () => {
    const w = world();
    populate(w, 2_000);
    const mine = w.nodes[0] as TNode;
    for (let i = 0; i < 6; i++) w.put(mine, `cc-main.s${i}`, { state: i === 0 ? "offline" : "working", parent: "cc-main" }, w.clock.t - i * MIN);
    w.put(mine, "cc-main.old", { state: "working", parent: "cc-main" }, w.clock.t - 2 * 60 * MIN); // stale: not live
    w.put(mine, "cc-other.s0", { state: "working", parent: "cc-other" }, w.clock.t - MIN);
    w.put(w.nodes[1] as TNode, "cc-main.s9", { state: "working", parent: "cc-main" }, w.clock.t - MIN); // another machine's: not counted
    expect(liveSubagents(w.core, "cc-main", "none", w.clock.t)).toBe(5);
    expect(liveSubagents(w.core, "cc-main", "cc-main.s1", w.clock.t)).toBe(4);
    const real = JSON.parse;
    let parses = 0;
    JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { parses++; return real(...a); }) as typeof JSON.parse;
    try {
      expect(liveSubagents(w.core, "cc-main", "none", w.clock.t)).toBe(5);
    } finally {
      JSON.parse = real;
    }
    expect(parses).toBe(0);
  });
});

describe("retention bounds the table and never costs a live agent or a machine that only looks offline", () => {
  test("2,250 records: the upkeep leaves at most the cap of archived agents per machine and every live agent", () => {
    const w = world();
    const mine = w.nodes[0] as TNode;
    // 1,500 sessions archived two days ago, 700 sub-agents archived hours ago (300 + 140 per machine), 50 live agents.
    for (let i = 0; i < 1_500; i++) w.put(w.nodes[i % 5] as TNode, `cc-old-${i}`, { state: "idle" }, w.clock.t - 2 * 86_400_000 - i * 1_000);
    for (let i = 0; i < 700; i++) w.put(w.nodes[i % 5] as TNode, `cc-p.s${i}`, { state: "offline", parent: "cc-p" }, w.clock.t - 3 * 3_600_000 - i * 1_000);
    for (let i = 0; i < 50; i++) w.put(w.nodes[i % 5] as TNode, `cc-live-${i}`, { state: "working" }, w.clock.t - 20_000);
    w.put(mine, "cc-mine-working", { state: "waiting" }, w.clock.t - 25 * MIN);
    expect(w.core.store.agents()).toHaveLength(2_251);
    const upkeep = new AgentArchive(w.core, asSync(w), createLogger({}), { now: () => w.clock.t });
    // Per machine 440 archived: the newest 100 sub-agents and the newest sessions up to the cap of 200 stay.
    expect(upkeep.tick()).toBe(5 * 240);
    const left = w.core.store.agents();
    expect(left).toHaveLength(2_251 - 1_200);
    for (const node of w.nodes) {
      const own = left.filter((r) => r.node === node.keys.nodeId && !r.agent.startsWith("cc-live-") && r.agent !== "cc-mine-working");
      expect(own).toHaveLength(ARCHIVE_CAP_PER_NODE);
      expect(own.filter((r) => r.agent.startsWith("cc-p.")).length).toBe(SUBAGENT_ARCHIVE_CAP_PER_NODE);
    }
    expect(left.filter((r) => r.agent.startsWith("cc-live-"))).toHaveLength(50);
    expect(left.some((r) => r.agent === "cc-mine-working")).toBe(true);
    expect(upkeep.tick()).toBe(0); // the table's size has settled
  });

  test("an agent is judged by its own status: a machine that looks offline gets none of its agents pruned", () => {
    const now = 10 * 86_400_000;
    const view = (agent: string, over: Partial<AgentView>, state: AgentState = "idle", updated: number = now - 15 * MIN): AgentView => ({
      id: `kira/kira-mbp/${agent}`, handle: "kira", node: "n9", hostname: "kira-mbp", agent,
      status: { agent, state, runtime: "claude-code" }, updated_at: updated, machine_online: true, effective_state: state, archived: false, ...over,
    });
    // Fresh idle sessions (15 min old) of a machine that looks offline: archived in the view (offline for 10 min), not on their own.
    const flapping = Array.from({ length: 5 }, (_, i) => view(`flap-${i}`, { machine_online: false, effective_state: "offline", archived: true }, "idle", now - 15 * MIN - i));
    // Sessions really archived (idle for days) on a machine that looks offline, and on one that is online.
    const old = (online: boolean, tag: string) => Array.from({ length: 5 }, (_, i) => view(`${tag}-${i}`, { machine_online: online, effective_state: online ? "idle" : "offline", archived: true }, "idle", now - 3 * 86_400_000 - i));
    const dropped = archiveOverflow([...flapping, ...old(false, "off"), ...old(true, "on")], now, 3);
    expect(dropped.filter((a) => a.agent.startsWith("flap-"))).toEqual([]);
    // Over a cap of 3, the 7 oldest of the 10 really archived go (the machine being offline changes nothing about that).
    expect(dropped).toHaveLength(7);
    // A working agent whose status went stale is offline on its own, whatever the machine does.
    const stale = view("stale", { machine_online: false, effective_state: "offline", archived: true }, "working", now - 40 * MIN);
    expect(archiveOverflow([stale], now, 0)).toEqual([stale]);
    // A session with a sub-agent working is never dropped, on an online machine (the view says so) or one that looks offline
    // (where nothing counts as working in the view: the sub-agent's own status says it).
    const onlineParent = view("parent-on", { archived: false, subagents: { working: 1, live: 1 } }, "idle", now - 5 * 86_400_000);
    expect(archiveOverflow([onlineParent], now, 0)).toEqual([]);
    const parent = view("parent", { machine_online: false, effective_state: "offline", archived: true }, "idle", now - 5 * 86_400_000);
    const child = { ...view("parent.s1", { machine_online: false, effective_state: "offline", archived: false }, "working", now - MIN), status: { agent: "parent.s1", state: "working" as const, runtime: "claude-code" as const, parent: "parent" } };
    expect(archiveOverflow([parent, child], now, 0)).toEqual([]);
    // Another machine's session with the same name is not protected by it, nor is one whose sub-agent stopped working.
    const other = { ...parent, node: "n8", id: "x/y/parent" };
    expect(archiveOverflow([other, child], now, 0)).toEqual([other]);
    const stopped = { ...child, status: { ...child.status, state: "idle" as const } };
    expect(archiveOverflow([parent, stopped], now, 0).map((a) => a.agent)).toEqual(["parent"]);
    expect(isArchivedAt("offline", now - OFFLINE_GRACE_MS, now)).toBe(true);
  });

  test("the upkeep keeps a session whose sub-agent works while its machine looks offline (cap 0 would drop it otherwise)", () => {
    const w = world();
    const kira = w.nodes[1] as TNode;
    w.put(kira, "cc-parent", { state: "idle" }, w.clock.t - 5 * 86_400_000);
    w.put(kira, "cc-parent.s1", { state: "working", parent: "cc-parent" }, w.clock.t - MIN);
    w.put(kira, "cc-lonely", { state: "idle" }, w.clock.t - 5 * 86_400_000);
    w.sync.offline.add(kira.keys.nodeId);
    const upkeep = new AgentArchive(w.core, asSync(w), createLogger({}), { cap: 0, now: () => w.clock.t });
    expect(upkeep.tick()).toBe(1);
    expect(w.core.store.agents().map((r) => r.agent).sort()).toEqual(["cc-parent", "cc-parent.s1"]);
  });

  test("the upkeep leaves the agents of a machine that looks offline alone, however small the cap", () => {
    const w = world();
    const kira = w.nodes[1] as TNode;
    // Idle for 15 minutes: live for a machine that is online, "archived" only because the machine looks offline now.
    for (let i = 0; i < 6; i++) w.put(kira, `cc-fresh-${i}`, { state: "idle" }, w.clock.t - 15 * MIN - i);
    // Really archived (idle for three days), and so over the cap of 2.
    for (let i = 0; i < 6; i++) w.put(kira, `cc-gone-${i}`, { state: "idle" }, w.clock.t - 3 * 86_400_000 - i);
    w.sync.offline.add(kira.keys.nodeId);
    const upkeep = new AgentArchive(w.core, asSync(w), createLogger({}), { cap: 2, now: () => w.clock.t });
    expect(upkeep.tick()).toBe(4); // the four oldest of the six really archived ones
    const left = w.core.store.agents().map((r) => r.agent).sort();
    expect(left).toEqual(["cc-fresh-0", "cc-fresh-1", "cc-fresh-2", "cc-fresh-3", "cc-fresh-4", "cc-fresh-5", "cc-gone-0", "cc-gone-1"]);
  });

  test("a hidden own-machine row that the upkeep deletes loses its status provenance too", () => {
    const w = world();
    const mine = w.nodes[0] as TNode;
    w.put(mine, "mine-gone", { state: "idle" }, w.clock.t - ARCHIVE_TTL_MS - 1_000);
    w.put(mine, "mine-fresh", { state: "idle" }, w.clock.t - 60_000);
    // The roster this daemon sees has its own machine revoked: nothing of it is shown, so only the hidden-row rule reaches its rows.
    const real = w.core.roster;
    const nodes = new Map([...real.nodes].map(([id, n]) => [id, id === w.core.nodeId ? { ...n, revoked: true } : n]));
    const forgotten: string[] = [];
    const seen = Object.create(w.core, {
      roster: { get: () => ({ ...real, nodes }) },
      forgetStatusProvenance: { value: (agents: readonly string[]) => { forgotten.push(...agents); } },
      reprojectOwnStatuses: { value: () => 0 },
    }) as Core;
    const upkeep = new AgentArchive(seen, asSync(w), createLogger({}), { now: () => w.clock.t });
    expect(upkeep.tick()).toBe(1);
    expect(forgotten).toEqual(["mine-gone"]);
    expect(w.core.store.agents().map((r) => r.agent)).toEqual(["mine-fresh"]);
  });

  test("records nothing shows (a revoked machine, a removed person) go once past the time limit, and nothing else does", () => {
    const w = world();
    const gone = tnode("gone");
    const { core } = w;
    // Rows of a machine the roster never heard of, of a revoked machine, and of a removed person; old and fresh.
    const stranger = tnode("stranger");
    for (const [n, tag] of [[stranger, "stranger"], [gone, "gone"]] as const) {
      w.put(n, `${tag}-old`, {}, w.clock.t - ARCHIVE_TTL_MS - 1_000);
      w.put(n, `${tag}-fresh`, {}, w.clock.t - ARCHIVE_TTL_MS + 60_000);
    }
    const alexNode = w.nodes[0] as TNode;
    w.put(alexNode, "mine-old", { state: "idle" }, w.clock.t - ARCHIVE_TTL_MS - 1_000); // visible: the archive's own rules decide
    w.put(w.nodes[3] as TNode, "sam-old", { state: "idle" }, w.clock.t - ARCHIVE_TTL_MS - 1_000);
    // gone: admitted, then revoked.
    const team = core.teamId as string;
    expect(core.ingest(memberEv(team, alexNode, gone, "member"), "local").status).toBe("accepted");
    expect(core.ingest(nodeEv(team, alexNode, gone), "local").status).toBe("accepted");
    expect(overdueHiddenRows(core, core.store.agents(), w.clock.t).map((r) => r.agent).sort()).toEqual(["stranger-old"]);
    expect(core.ingest(nodeEv(team, alexNode, gone, true), "local").status).toBe("accepted");
    expect(overdueHiddenRows(core, core.store.agents(), w.clock.t).map((r) => r.agent).sort()).toEqual(["gone-old", "stranger-old"]);
    expect(core.ingest(memberEv(team, alexNode, w.nodes[3] as TNode, "removed"), "local").status).toBe("accepted");
    expect(overdueHiddenRows(core, core.store.agents(), w.clock.t).map((r) => r.agent).sort()).toEqual(["gone-old", "sam-old", "stranger-old"]);
    // The upkeep removes exactly those (and the visible old idle rows by the archive's ordinary time limit).
    const upkeep = new AgentArchive(core, asSync(w), createLogger({}), { now: () => w.clock.t });
    upkeep.tick();
    const left = core.store.agents().map((r) => r.agent).sort();
    expect(left).toEqual(["gone-fresh", "stranger-fresh"]);
    // Before the roster is known nothing is judged.
    expect(overdueHiddenRows({ roster: { team: null, nodes: new Map(), members: new Map(), channels: new Map() } }, [{ node: "x", agent: "y", handle: "h", event_id: "e", ts: 1, body: "{}" }], w.clock.t)).toEqual([]);
  });
});

describe("AgentSince inside the roster read", () => {
  test("rows sharing a display id (two machines, one hostname) get the starts of the last of them, as before", () => {
    const w = world();
    const [, k1, k2] = w.nodes as [TNode, TNode, TNode];
    w.put(k1, "twin", { state: "working", activity: "A" }, w.clock.t - 10 * MIN);
    w.put(k2, "twin", { state: "idle" }, w.clock.t - 5 * MIN);
    const twins = views(w).filter((v) => v.agent === "twin");
    expect(twins).toHaveLength(2);
    expect(twins[0]?.id).toBe(twins[1]?.id);
    expect([twins[0]?.state_since, twins[0]?.activity_since]).toEqual([twins[1]?.state_since, twins[1]?.activity_since]);
  });
});
