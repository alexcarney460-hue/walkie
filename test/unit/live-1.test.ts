// WALKIE-LIVE-1: the stream's agent roster as deltas (opt-in `?agents=delta`), with a revision chain the client checks.
// Full-snapshot clients (the desktop tray, the CLI) keep getting whole `agents` frames.
import { afterEach, describe, expect, test } from "bun:test";
import { Hub, type HubProviders } from "../../src/daemon/sse.ts";
import type { AgentView, AgentsPayload, StreamMessage } from "../../src/protocol/schemas.ts";

const agent = (id: string, activity: string, updated_at = 1): AgentView => ({
  id, handle: "alex", hostname: "mbp", node: "n1", agent: id.split("/").pop() ?? id, machine_online: true, archived: false,
  effective_state: "working", updated_at,
  status: { agent: id, state: "working", runtime: "claude-code", activity },
});

let roster: AgentView[] = [];
const providers: HubProviders = {
  agents: (): AgentsPayload => ({ agents: roster, archive: [{ node: "n1", idle: 1, offline: 2 }], archive_rev: 7 }),
  nodes: () => [],
  visible: () => true,
};

const hubs: Hub[] = [];
afterEach(() => { for (const h of hubs.splice(0)) h.close(); });

function makeHub(): Hub {
  const hub = new Hub(60_000, 5);
  hub.setProviders(providers);
  hubs.push(hub);
  return hub;
}

/** Reads SSE frames from a stream Response as they arrive. */
function reader(res: Response) {
  const r = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: { event: string; data: StreamMessage; bytes: number }[] = [];
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
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (ev && data) frames.push({ event: ev, data: JSON.parse(data) as StreamMessage, bytes: raw.length });
      }
    }
  };
  return { frames, pump };
}

function open(hub: Hub, delta: boolean) {
  const ac = new AbortController();
  const res = hub.open(null, delta ? [] : [{ type: "agents", ...providers.agents() }], ac.signal, undefined, { agentsDelta: delta });
  expect(res).not.toBeNull();
  return { ...reader(res as Response), close: () => ac.abort() };
}

type Snapshot = Extract<StreamMessage, { type: "agents" }>;
type Delta = Extract<StreamMessage, { type: "agents.delta" }>;

describe("agent deltas on the stream", () => {
  test("a delta client gets one full snapshot with a revision, then only the rows that changed", async () => {
    roster = Array.from({ length: 80 }, (_, i) => agent(`alex/mbp/cc-${i}`, "Running a command"));
    const hub = makeHub();
    const c = open(hub, true);
    await c.pump(30);
    const snap = c.frames.find((f) => f.event === "agents")?.data as Snapshot | undefined;
    expect(snap?.agents.length).toBe(80);
    expect(typeof snap?.rev).toBe("number");

    roster = roster.map((a, i) => (i === 3 ? agent(a.id, "Editing files", 2) : a));
    hub.agentsChanged();
    await c.pump(60);
    const deltas = c.frames.filter((f) => f.event === "agents.delta");
    expect(deltas.length).toBe(1);
    const d = deltas[0]!.data as Delta;
    expect(d.base).toBe(snap!.rev as number);
    expect(d.rev).toBeGreaterThan(d.base);
    expect(d.upsert.map((a) => a.id)).toEqual(["alex/mbp/cc-3"]);
    expect(d.upsert[0]!.status.activity).toBe("Editing files");
    expect(d.remove).toEqual([]);
    expect(d.archive).toEqual([{ node: "n1", idle: 1, offline: 2 }]);
    // The point of it: a one-row change costs a fraction of a snapshot.
    const snapBytes = c.frames.find((f) => f.event === "agents")!.bytes;
    expect(deltas[0]!.bytes * 10).toBeLessThan(snapBytes);
    c.close();
  });

  test("no delta is sent when nothing changed; removals are sent as ids", async () => {
    roster = [agent("a/1", "x"), agent("a/2", "y")];
    const hub = makeHub();
    const c = open(hub, true);
    await c.pump(20);
    hub.agentsChanged();
    await c.pump(40);
    expect(c.frames.filter((f) => f.event === "agents.delta").length).toBe(0);
    roster = [roster[0]!];
    hub.agentsChanged();
    await c.pump(40);
    const d = c.frames.find((f) => f.event === "agents.delta")!.data as Delta;
    expect(d.remove).toEqual(["n1/2"]); // row keys: node id / agent
    expect(d.upsert).toEqual([]);
    c.close();
  });

  test("full-snapshot clients keep getting whole agents frames (desktop tray, CLI)", async () => {
    roster = [agent("a/1", "x"), agent("a/2", "y")];
    const hub = makeHub();
    const c = open(hub, false);
    await c.pump(20);
    roster = [agent("a/1", "changed", 2), roster[1]!];
    hub.agentsChanged();
    await c.pump(40);
    const agentsFrames = c.frames.filter((f) => f.event === "agents");
    expect(agentsFrames.length).toBe(2);
    expect((agentsFrames[1]!.data as Snapshot).agents.length).toBe(2);
    expect(c.frames.some((f) => f.event === "agents.delta")).toBe(false);
    c.close();
  });

  test("a client that joins between broadcasts still ends up exactly on the daemon's roster (no ghost rows)", async () => {
    roster = [agent("a/1", "x")];
    const hub = makeHub();
    const first = open(hub, true);
    await first.pump(20);
    // Changes the hub has not broadcast yet: an agent appears, one changes.
    roster = [agent("a/1", "x2", 2), agent("a/ghost", "brief")];
    const second = open(hub, true); // opening flushes pending changes to existing clients first
    await Promise.all([first.pump(20), second.pump(20)]);
    roster = [agent("a/1", "x3", 3)]; // the ghost leaves
    hub.agentsChanged();
    await Promise.all([first.pump(40), second.pump(40)]);

    for (const c of [first, second]) {
      let rows = new Map<string, AgentView>();
      let rev: number | null = null;
      for (const f of c.frames) {
        if (f.event === "agents") {
          const s = f.data as Snapshot;
          rows = new Map(s.agents.map((a) => [`${a.node}/${a.agent}`, a]));
          rev = s.rev ?? null;
        } else if (f.event === "agents.delta") {
          const d = f.data as Delta;
          expect(d.base).toBe(rev as number); // an unbroken chain
          for (const a of d.upsert) rows.set(`${a.node}/${a.agent}`, a);
          for (const id of d.remove) rows.delete(id);
          rev = d.rev;
        }
      }
      expect([...rows.values()].map((a) => a.id)).toEqual(["a/1"]);
      expect(rows.get("n1/1")!.status.activity).toBe("x3");
    }
    first.close();
    second.close();
  });
});

describe("connects don't broadcast (LIVE-3, Opus r1 LOW)", () => {
  test("a delta client connecting sends the roster to it alone when nothing changed", async () => {
    roster = [agent("a/1", "x"), agent("a/2", "y")];
    const hub = makeHub();
    const full = open(hub, false);
    const d1 = open(hub, true);
    await Promise.all([full.pump(20), d1.pump(20)]);
    const before = { full: full.frames.length, d1: d1.frames.length };
    const d2 = open(hub, true);
    await Promise.all([full.pump(30), d1.pump(30), d2.pump(30)]);
    expect(full.frames.length).toBe(before.full);
    expect(d1.frames.length).toBe(before.d1);
    expect(d2.frames.filter((f) => f.event === "agents")).toHaveLength(1);
    for (const c of [full, d1, d2]) c.close();
  });

  test("a change pending when a delta client connects still reaches whole-snapshot clients", async () => {
    roster = [agent("a/1", "x")];
    const hub = makeHub();
    const full = open(hub, false);
    await full.pump(20);
    roster = [agent("a/1", "changed", 2)];
    hub.agentsChanged(); // debounce pending
    const d = open(hub, true); // the first delta client: its baseline read sees the change
    await Promise.all([full.pump(40), d.pump(40)]);
    const last = full.frames.filter((f) => f.event === "agents").at(-1)!.data as Snapshot;
    expect(last.agents[0]!.status.activity).toBe("changed");
    full.close();
    d.close();
  });
});

describe("delta row identity (Codex r1 #1)", () => {
  test("two machines with one hostname and agent name (same display id) stay two rows through updates and removals", async () => {
    const onNode = (node: string, activity: string, updated_at = 1): AgentView => ({ ...agent("alex/mbp/cc-1", activity, updated_at), node });
    roster = [onNode("n1", "first"), onNode("n2", "second")];
    const hub = makeHub();
    const c = open(hub, true);
    await c.pump(20);
    roster = [onNode("n1", "first, updated", 2), onNode("n2", "second")];
    hub.agentsChanged();
    await c.pump(40);
    roster = [onNode("n1", "first, updated", 2)];
    hub.agentsChanged();
    await c.pump(40);
    let rows = new Map<string, AgentView>();
    for (const f of c.frames) {
      if (f.event === "agents") rows = new Map((f.data as Snapshot).agents.map((a) => [`${a.node}/${a.agent}`, a]));
      if (f.event === "agents.delta") {
        const d = f.data as Delta;
        for (const a of d.upsert) rows.set(`${a.node}/${a.agent}`, a);
        for (const k of d.remove) rows.delete(k);
      }
    }
    expect([...rows.values()].map((a) => `${a.node}:${a.status.activity}`)).toEqual(["n1:first, updated"]);
    const deltas = c.frames.filter((f) => f.event === "agents.delta").map((f) => f.data as Delta);
    expect(deltas).toHaveLength(2);
    expect(deltas[1]!.remove).toEqual(["n2/cc-1"]);
    c.close();
  });
});
