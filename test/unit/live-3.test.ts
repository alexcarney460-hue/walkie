// WALKIE-LIVE-3 (Opus r1 findings): sessions with open streams across restarts, strict saves, the MCP push loop.
import { expect, test } from "bun:test";
import { DashboardSessions, SESSION_IDLE_MS, SESSION_STREAM_REFRESH_MS } from "../../src/daemon/dashboard-sessions.ts";
import { connectSession } from "../../src/mcp/server.ts";
import type { MeView } from "../../src/protocol/schemas.ts";

const HOST = "127.0.0.1:7457";
const box = () => { let v: string | null = null; return { load: () => v, save: (x: string | null) => { v = x; }, get: () => v }; };

test("MED 1: a dashboard left open 13 h (stream, no requests) survives an upgrade restart", () => {
  let now = 1_000_000;
  const p = box();
  const a = new DashboardSessions({ now: () => now, persist: p });
  const v = a.create(HOST);
  a.openStream(a.check(v, HOST)!);
  now += 13 * 3_600_000; // no request since: only the stream
  a.close();
  now += 30_000;
  const b = new DashboardSessions({ now: () => now, persist: p });
  expect(b.check(v, HOST)).not.toBeNull();
  expect(13 * 3_600_000).toBeGreaterThan(SESSION_IDLE_MS); // the case the finding describes
});

test("MED 1: while a stream is open the saved lastSeen moves forward (sweep), so a crash doesn't sign it out either", () => {
  let now = 0;
  const p = box();
  const a = new DashboardSessions({ now: () => now, persist: p });
  const v = a.create(HOST);
  a.openStream(a.check(v, HOST)!);
  for (let t = 0; t < 13 * 60; t++) { now += 60_000; a.sweep(); } // 13 h of minute sweeps
  const saved = JSON.parse(p.get() as string) as { s: { l: number }[] };
  expect(now - saved.s[0]!.l).toBeLessThanOrEqual(SESSION_STREAM_REFRESH_MS);
  // Without close() (a crash): the next run still accepts it.
  now += 60_000;
  expect(new DashboardSessions({ now: () => now, persist: p }).check(v, HOST)).not.toBeNull();
});

test("LOW: logout / rotation fail loudly when the saved hashes can't be cleared; only shutdown and the sweep stay quiet", () => {
  let fail = false;
  const s = new DashboardSessions({ now: () => 0, persist: { load: () => null, save: () => { if (fail) throw new Error("disk"); } } });
  s.create(HOST);
  fail = true;
  expect(() => s.revokeAll()).toThrow("disk");
  expect(() => s.close()).not.toThrow();
  expect(() => s.sweep()).not.toThrow();
});

test("Codex #2: a rotation ends saved sessions even if clearing them on disk failed (generation binding)", () => {
  const p = box();
  const a = new DashboardSessions({ now: () => 0, persist: p, generation: "gen-1" });
  const v = a.create(HOST);
  a.close();
  const stale = p.get(); // what a failed clear would have left on disk
  expect(new DashboardSessions({ now: () => 1, persist: p, generation: "gen-1" }).check(v, HOST)).not.toBeNull();
  p.save(stale);
  expect(new DashboardSessions({ now: () => 1, persist: p, generation: "gen-2" }).check(v, HOST)).toBeNull();
  p.save(stale);
  const b = new DashboardSessions({ now: () => 1, persist: p, generation: "gen-1" });
  b.setGeneration("gen-2");
  b.create(HOST);
  expect(JSON.parse(p.get() as string).g).toBe("gen-2"); // new sessions are saved under the new token
});

test("MED 2: an unnamed MCP session pushes from the start; only its announcement waits", async () => {
  const log: string[] = [];
  const ac = new AbortController();
  const me = { team: { id: "t", name: "x" } } as unknown as MeView;
  const done = connectSession({
    me: async () => me, announce: async () => { log.push("announce"); }, catchUp: async () => { log.push("catch-up"); },
    push: async () => { log.push("push"); await new Promise((r) => ac.signal.addEventListener("abort", r)); },
    graceMs: 80, signal: ac.signal,
  });
  await Bun.sleep(20);
  expect(log).toEqual(["push"]);
  await Bun.sleep(100);
  expect(log).toEqual(["push", "announce", "catch-up"]);
  ac.abort();
  await done;
});

test("MED 2: a one-shot run that exits within the grace never announces", async () => {
  const log: string[] = [];
  const ac = new AbortController();
  const me = { team: { id: "t", name: "x" } } as unknown as MeView;
  const done = connectSession({ me: async () => me, announce: async () => { log.push("announce"); }, push: async () => { log.push("push"); }, graceMs: 200, signal: ac.signal });
  await Bun.sleep(20);
  ac.abort();
  await done;
  expect(log).toEqual(["push"]);
});

// ---- peer-supplied observed_at can't stretch time-in-state (Opus r1 LOW) ----------------------------------------------
import { afterEach } from "bun:test";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { agentsPayload } from "../../src/daemon/views.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

test("a peer's status backdated 20 min with observed_at starts its time-in-state when this node received it", () => {
  const alex = tnode("alex");
  const kira = tnode("kira");
  const { team, create } = createTeam(alex);
  const core = makeCore(alex, team, cleanups, { clock: () => Date.now() });
  core.ingest(create, "local");
  for (const e of [memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira)]) expect(core.ingest(e, "local").status).toBe("accepted");
  const ts = Date.now();
  const status = ev(team, kira, "agent.status", { agent: "cc-1", state: "working", runtime: "claude-code", activity: "Running a command", observed_at: ts - 20 * 60_000 }, { agent: "cc-1", ts });
  const before = Date.now();
  const r = core.ingest(status, "remote");
  expect(JSON.stringify(r)).toContain("accepted");
  const online = { isOnline: () => true } as unknown as SyncManager;
  const a = agentsPayload(core, online, {}, Date.now()).agents.find((x) => x.agent === "cc-1")!;
  expect(a.updated_at).toBe(ts - 20 * 60_000); // the archive / stale rules still see the claim...
  expect(a.activity_since).toBeGreaterThanOrEqual(before); // ...but the card does not say "20m"
  expect(a.state_since).toBeGreaterThanOrEqual(before);
});
