// WALKIE-LIVE-1: the dashboard's stream controller (stall watchdog, delta chain, sign-out) and the roster delta reducer.
import { expect, test } from "bun:test";
import { ApiError } from "../src/api/client.ts";
import type { AgentView, StreamMessage } from "../src/api/types.ts";
import { LiveStream, type StreamFn } from "../src/state/live-stream.ts";
import { applyAgentsDelta, initialState, reducer, type Action } from "../src/state/reducer.ts";

const agent = (id: string, activity: string): AgentView => ({
  id, handle: "alex", hostname: "mbp", node: "n1", agent: id, machine_online: true, archived: false,
  effective_state: "working", updated_at: 1, status: { agent: id, state: "working", runtime: "claude-code", activity },
});

interface Conn { open: () => void; send: (m: StreamMessage) => void; data: () => void; end: (err?: unknown) => void; signal: AbortSignal }

/** A scripted stream: each call to it is one connection the test drives. */
function fakeStream() {
  const calls: Conn[] = [];
  const stream: StreamFn = (onOpen, onMessage, onData, signal) => new Promise<void>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    calls.push({
      open: onOpen, signal,
      send: (m) => { onData(); onMessage(m.type, JSON.stringify(m)); },
      data: onData,
      end: (err) => (err ? reject(err) : resolve()),
    });
  });
  return { calls, stream };
}

function harness(opts: { stallMs?: number; checkMs?: number } = {}) {
  const { calls, stream } = fakeStream();
  const actions: Action[] = [];
  let resyncs = 0;
  let signedOut = 0;
  const live = new LiveStream({
    stream, dispatch: (a) => actions.push(a), resync: async () => { resyncs++; },
    checkSession: async () => ({}), onSignedOut: () => { signedOut++; },
    backoff: () => 5, stallMs: opts.stallMs ?? 60_000, checkMs: opts.checkMs ?? 60_000,
  });
  const conns = () => actions.filter((a): a is Extract<Action, { type: "conn" }> => a.type === "conn").map((a) => `${a.conn.status}${a.conn.reason ? `:${a.conn.reason}` : ""}`);
  return { live, calls, actions, conns, resyncs: () => resyncs, signedOut: () => signedOut };
}

const snapshot = (rev: number, agents: AgentView[]): StreamMessage => ({ type: "agents", rev, agents, archive: [] });
const delta = (base: number, rev: number, upsert: AgentView[], remove: string[] = []): StreamMessage => ({ type: "agents.delta", base, rev, upsert, remove, archive: [] });

test("a stream that stops delivering (no heartbeat) is replaced; the indicator leaves Live while it is", async () => {
  const h = harness({ stallMs: 60, checkMs: 10 });
  h.live.start();
  h.calls[0]!.open();
  h.calls[0]!.send(snapshot(1, [agent("a", "x")]));
  // Heartbeats keep it live...
  for (let i = 0; i < 4; i++) { await Bun.sleep(25); h.calls[0]!.data(); }
  expect(h.calls.length).toBe(1);
  // ...silence doesn't.
  await Bun.sleep(120);
  expect(h.calls[0]!.signal.aborted).toBe(true);
  expect(h.calls.length).toBe(2);
  expect(h.conns()).toEqual(["connecting", "live", "reconnecting:stalled"]);
  h.calls[1]!.open();
  expect(h.conns().at(-1)).toBe("live");
  expect(h.resyncs()).toBe(1);
  h.live.stop();
});

test("roster deltas apply in order; a delta that skips a revision reconnects instead of applying", async () => {
  const h = harness();
  h.live.start();
  h.calls[0]!.open();
  h.calls[0]!.send(snapshot(4, [agent("a", "x"), agent("b", "y")]));
  h.calls[0]!.send(delta(4, 5, [agent("a", "x2")]));
  h.calls[0]!.send(delta(7, 8, [agent("b", "never")])); // 5 → 7: one was missed
  await Bun.sleep(1);
  const deltas = h.actions.filter((a) => a.type === "agents/delta");
  expect(deltas.length).toBe(1);
  expect(h.calls[0]!.signal.aborted).toBe(true);
  expect(h.calls.length).toBe(2);
  expect(h.conns().at(-1)).toBe("reconnecting:gap");
  // The replacement stream starts from a fresh snapshot, then deltas chain from it again.
  h.calls[1]!.open();
  h.calls[1]!.send(snapshot(8, [agent("a", "x2"), agent("b", "y2")]));
  h.calls[1]!.send(delta(8, 9, [agent("b", "y3")]));
  expect(h.actions.filter((a) => a.type === "agents/delta").length).toBe(2);
  h.live.stop();
});

test("repeated gaps back off instead of reconnecting in a hot loop", async () => {
  const h = harness();
  h.live.start();
  h.calls[0]!.open();
  h.calls[0]!.send(snapshot(1, []));
  h.calls[0]!.send(delta(2, 3, [])); // gap 1: reconnect now
  expect(h.calls.length).toBe(2);
  h.calls[1]!.open();
  h.calls[1]!.send(snapshot(5, []));
  h.calls[1]!.send(delta(9, 10, [])); // gap 2 in a row: waits (backoff 5 ms here)
  expect(h.calls.length).toBe(2);
  expect(h.conns().at(-1)).toBe("reconnecting:gap");
  await Bun.sleep(20);
  expect(h.calls.length).toBe(3);
  h.live.stop();
});

test("frames from a replaced stream are ignored", async () => {
  const h = harness();
  h.live.start();
  h.calls[0]!.open();
  h.calls[0]!.send(snapshot(1, []));
  h.calls[0]!.send(delta(3, 4, [])); // gap → replaced
  const before = h.actions.length;
  h.calls[0]!.send(snapshot(99, [agent("stale", "old")]));
  expect(h.actions.length).toBe(before);
  h.live.stop();
});

test("a 401 (session ended) stops reconnecting and signs out once", async () => {
  const h = harness();
  h.live.start();
  h.calls[0]!.end(new ApiError("unauthorized", "session ended", 401));
  await Bun.sleep(30);
  expect(h.signedOut()).toBe(1);
  expect(h.calls.length).toBe(1);
});

test("a stream the daemon closes reconnects with backoff and resyncs", async () => {
  const h = harness();
  h.live.start();
  h.calls[0]!.open();
  h.calls[0]!.end();
  await Bun.sleep(1);
  expect(h.conns().at(-1)).toBe("reconnecting:closed");
  await Bun.sleep(20);
  expect(h.calls.length).toBe(2);
  h.calls[1]!.open();
  expect(h.resyncs()).toBe(1);
  h.live.stop();
});

test("streams accepted and dropped at once keep backing off; only one that stayed up 30 s resets it (Codex r1 #6)", async () => {
  const { calls, stream } = fakeStream();
  const attempts: number[] = [];
  let clock = 0;
  const live = new LiveStream({
    stream, dispatch: () => {}, resync: async () => {}, checkSession: async () => ({}), onSignedOut: () => {},
    now: () => clock, stallMs: 1e9, checkMs: 1e9, stableMs: 30_000,
    backoff: (n) => { attempts.push(n); return 1; },
  });
  live.start();
  for (let i = 0; i < 4; i++) {
    calls[i]!.open();
    calls[i]!.end(); // accepted, then dropped at once
    await Bun.sleep(5);
  }
  expect(attempts).toEqual([0, 1, 2, 3]);
  calls[4]!.open();
  clock += 31_000; // healthy for 31 s
  calls[4]!.end();
  await Bun.sleep(5);
  expect(attempts.at(-1)).toBe(0);
  live.stop();
});

test("applyAgentsDelta keys rows by node + agent: one display id on two machines stays two rows (Codex r1 #1)", () => {
  const x1 = { ...agent("same", "one"), node: "n1" };
  const x2 = { ...agent("same", "two"), node: "n2" };
  const upd = { ...agent("same", "one, updated"), node: "n1" };
  expect(applyAgentsDelta([x1, x2], [upd], []).map((r) => `${r.node}:${r.status.activity}`)).toEqual(["n1:one, updated", "n2:two"]);
  expect(applyAgentsDelta([x1, x2], [], ["n2/same"]).map((r) => r.node)).toEqual(["n1"]);
});

test("applyAgentsDelta: changed rows replaced in place, unchanged rows keep identity, new appended, removed dropped", () => {
  const a = agent("a", "x");
  const b = agent("b", "y");
  const c = agent("c", "z");
  const b2 = agent("b", "y2");
  const d = agent("d", "new");
  const out = applyAgentsDelta([a, b, c], [b2, d], ["n1/c"]);
  expect(out.map((x) => x.id)).toEqual(["a", "b", "d"]);
  expect(out[0]).toBe(a);
  expect(out[1]).toBe(b2);
  const same = [a];
  expect(applyAgentsDelta(same, [], [])).toBe(same);
  const s = reducer({ ...initialState, agents: [a, b] }, { type: "agents/delta", upsert: [b2], remove: [], archive: [{ node: "n1", idle: 1, offline: 0 }], archiveRev: 3 });
  expect(s.agents[1]!.status.activity).toBe("y2");
  expect(s.archive).toEqual([{ node: "n1", idle: 1, offline: 0 }]);
  expect(s.archiveRev).toBe(3);
});
