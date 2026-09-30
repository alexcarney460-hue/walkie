// R17 check 3 (regression hunt): e90b16e binds EVERY progress put to a claim found in loadScheduleClaims(core, currentTerm).
// The claim store is per authority term and is re-seeded lazily (first claim per schedule in the new term). What happens to an
// in-flight run's COMPLETION progress when the roster authority is transferred mid-run?
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { loadScheduleClaims, uncoveredAuthority } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { signSchedulePeer } from "../../src/daemon/orchestrator/schedule-forward.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { PeerCallError, type PeerClient } from "../../src/daemon/peer-client.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });

test("authority transferred while a run is in flight: lead records completion on successor", async () => {
  const L = { makeCore, createTeam, now, tnode, Leadership, Schedules, readSchedules,
    uncoveredAuthority, signSchedulePeer, PeerApi, registerHost, SCHEDULE_CHANNEL };
  const a = L.tnode("alex"), k = L.tnode("mira"), b = L.tnode("bea");
  const { team, create } = L.createTeam(a);
  const base = Math.floor(L.now() / 3_600_000) * 3_600_000 + 3_600_000;
  const wall = { value: base - 2 * 60_000 };
  setSystemTime(new Date(wall.value));
  const A = L.makeCore(a, team, cleanups, { clock: () => wall.value });
  A.ingest(create, "local");
  for (const n of [k, b]) { A.emit("team.member", { login: n.login, handle: n.handle, role: "owner" });
    A.emit("team.node", { node_id: n.keys.nodeId, login: n.login, hostname: n.hostname, pubkey: n.keys.pubkey, ip: "127.0.0.1" }); }
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: L.SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "bea", "mira"] });
  const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };
  const mono = { v: 34_000 };
  const mkHost = (core: any) => { const lead = new L.Leadership({ core, preferred: () => k.keys.nodeId, lost: () => {}, now: () => wall.value, monoNow: () => mono.v });
    const s = new L.Schedules(core, idle);
    L.registerHost(core, { schedules: s, grantLeadership: (n: string) => lead.grant(n), holdsScheduleLease: (n: string, e: number) => lead.holds(n, e), claimSchedule: (n: string, c: never) => lead.claimFromPeer(n, c) } as unknown as OrchestratorHost);
    return { lead, s, api: new L.PeerApi(core) as unknown as { serveAdmitted: (r: Request, u: URL, n: string, m: { handle: string; role: string }) => Promise<Response> } }; };
  const hostA = mkHost(A);
  const K = L.makeCore(k, team, cleanups, { clock: () => wall.value });
  const B = L.makeCore(b, team, cleanups, { clock: () => wall.value });
  const all = () => A.store.queryEvents({ limit: 100000 }).map((r: { json: string }) => JSON.parse(r.json)).sort((x: { seq: number }, y: { seq: number }) => x.seq - y.seq);
  const sync = (...cores: any[]) => { for (const c of cores) for (const e of all()) c.ingest(e, "remote"); };
  sync(K);
  let target: "A" | "B" = "A"; let hostB: ReturnType<typeof mkHost> | null = null;
  const call = async (path: string, wire: unknown) => {
    const host = target === "A" ? hostA : hostB!;
    const url = new URL(`http://peer/peer/v1/orchestrator/${path}`);
    try { const r = await host.api.serveAdmitted(new Request(url, { method: "POST", body: JSON.stringify(wire) }), url, k.keys.nodeId, { handle: "mira", role: "owner" }); return await r.json(); }
    catch (err) { const e = err as { status?: number; code?: string; message?: string }; throw new PeerCallError(e.status ?? 0, e.code ?? "x", e.message ?? ""); }
  };
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 9 }), leadLease: (_a: unknown, w: unknown) => call("lease", w),
    scheduleClaim: async (_a: unknown, w: unknown) => call("schedule-claim", w), scheduleProgress: async (_a: unknown, w: unknown) => call("schedule-progress", w), scheduleDefaults: (_a: unknown, w: unknown) => call("schedule-defaults", w) };
  const leadK = new L.Leadership({ core: K, client: client as unknown as PeerClient, preferred: () => k.keys.nodeId, lost: () => {} });
  let turns = 0; let replyOk = false;
  const runner = { valid: () => leadK.valid, epoch: () => leadK.epoch, leaseFailure: () => leadK.leaseFailure,
    claim: (id: string, slot: number, run: string, rn?: boolean, t?: readonly string[]) => leadK.claimSchedule(id, slot, run, rn, t),
    turn: () => `t${++turns}`, reply: () => (replyOk ? { text: "long job failed", ok: false } : null), interrupt: () => {}, capacityTargets: () => [] };
  const SK = new L.Schedules(K, runner, client as unknown as PeerClient);
  const x = hostA.s.add({ name: "Daily", cron: "0 * * * *", task: { prompt: "long job" } }, "alex");
  A.emit("msg.post", { text: "walkie-talkie-schedule:v1:" + JSON.stringify({ op: "put", term: 0,
    after: null, epoch: 0, rev: 1, schedule: { ...x, failures: 2 } }) }, { channel: SCHEDULE_CHANNEL });
  sync(K);
  wall.value = x.next_run! + 2_000; setSystemTime(new Date(wall.value));
  await leadK.acquire(); await SK.tick(wall.value);
  const a1 = L.readSchedules(A).find((s: { id: string }) => s.id === x.id)!;
  expect(a1.run_id).not.toBeNull();
  expect(turns).toBe(1);
  // 2. roster authority moves to bea while the run is in flight
  const transfer = A.emit("team.authority", { node_id: b.keys.nodeId });
  sync(K, B);
  hostB = mkHost(B);
  target = "B";
  expect(B.isAuthority()).toBe(true);
  expect(L.uncoveredAuthority(B)).toBeNull();
  await leadK.acquire(); // lead re-leases from the new authority
  mono.v += 120_000; wall.value += 120_000; setSystemTime(new Date(wall.value)); await leadK.acquire();
  expect(leadK.valid).toBe(true);
  replyOk = true;
  await SK.tick(wall.value);
  const b1 = L.readSchedules(B).find((s: { id: string }) => s.id === x.id)!;
  expect(loadScheduleClaims(B, B.authorityLeaseTerm)).toHaveLength(1);
  expect(b1.last_result).toContain("long job failed");
  expect(b1.last_result).toContain("Paused after three failures");
  expect(b1.failures).toBe(3);
  expect(b1.enabled).toBe(false);
  expect(b1.next_run).toBeNull();
  void transfer; void idle;
});
