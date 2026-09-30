// R15 attack 1 (residual): only schedule-manage is node-key signed. The lease, claim and progress peer routes still
// trust the Tailscale gate alone (whois login + source IP + X-Walkie-Node header), which identifies the MACHINE,
// not the OS user. A seat user or the walkie-talkie uid on the lead's machine reaches them as that node. What can it
// do with no key? Real Cores and the real PeerApi handler; nothing in the repo is modified.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { signSchedulePeer } from "../../src/daemon/orchestrator/schedule-forward.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore } from "../../test/helpers/core.ts";
import { createTeam, now, tnode } from "../../test/helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
type Serve = { serveAdmitted: (req: Request, url: URL, node: string, member: { handle: string; role: string }) => Promise<Response> };

test("P3 no node key: lease epoch, a claim for the due slot, and a progress put that retires the schedule", async () => {
  const a = tnode("alex"), k = tnode("mira");
  const { team, create } = createTeam(a);
  const base = Math.floor(now() / 3_600_000) * 3_600_000 + 3_600_000;
  const wall = { value: base - 2 * 60_000 };
  setSystemTime(new Date(wall.value));
  const A = makeCore(a, team, cleanups, { clock: () => wall.value });
  A.ingest(create, "local");
  A.emit("team.member", { login: k.login, handle: k.handle, role: "owner" });
  A.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname, pubkey: k.keys.pubkey, ip: "127.0.0.1" });
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "mira"] });
  const mono = { v: 34_000 };
  const leadA = new Leadership({ core: A, preferred: () => k.keys.nodeId, lost: () => {}, now: () => wall.value, monoNow: () => mono.v });
  const sA = new Schedules(A, { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} });
  registerHost(A, { schedules: sA, grantLeadership: (n: string) => leadA.grant(n), holdsScheduleLease: (n: string, e: number) => leadA.holds(n, e),
    claimSchedule: (n: string, c: never) => leadA.claimFromPeer(n, c) } as unknown as OrchestratorHost);
  const api = new PeerApi(A) as unknown as Serve;
  const mira = { handle: "mira", role: "owner" };
  const post = async (path: string, body: unknown) => {
    const url = new URL(`http://peer${path}`);
    try { const r = await api.serveAdmitted(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, k.keys.nodeId, mira); return { status: r.status, body: await r.json() as Record<string, unknown> }; }
    catch (err) { const e = err as { status?: number; code?: string; message?: string }; return { status: e.status, code: e.code, message: e.message?.slice(0, 120) }; }
  };

  // mira's real daemon is the lead (lease holder).
  const real = leadA.grant(k.keys.nodeId);
  const x = sA.add({ name: "Invoice sweep", cron: "*/5 * * * *", task: { prompt: "SEND THE INVOICE SWEEP" } }, "alex");
  // A different OS user on mira's machine: it has no node key, only the machine's tailnet identity.
  const lease = await post("/peer/v1/orchestrator/lease", {});
  console.log("P3 lease as mira's node, no key:", JSON.stringify(lease), "| real grant epoch:", real.epoch);
  const epoch = (lease.body as { epoch?: number })?.epoch ?? real.epoch;
  wall.value = x.next_run! + 5_000; setSystemTime(new Date(wall.value));
  const forgedRun = randomUUID();
  const claim = await post("/peer/v1/orchestrator/schedule-claim", { schedule: x.id, slot: x.next_run, run: forgedRun, epoch });
  console.log("P3 forged claim for the due slot:", JSON.stringify(claim));
  const current = readSchedules(A).find((s) => s.id === x.id)!;
  const progress = await post("/peer/v1/orchestrator/schedule-progress", { epoch, run_id: current.run_id,
    change: { op: "put", schedule: { ...current, run_id: forgedRun, last_run: wall.value, next_run: null, last_result: "ok" } } });
  console.log("P3 forged progress put (next_run null):", progress.status, JSON.stringify(progress.body ?? progress).slice(0, 160));
  const after = readSchedules(A).find((s) => s.id === x.id)!;
  console.log("P3 authority's folded schedule:", JSON.stringify({ enabled: after.enabled, next_run: after.next_run, last_result: after.last_result }));
  expect(lease.status).toBe(400);
  expect(claim.status).toBe(400);
  expect(progress.status).toBe(400);
  expect((await post("/peer/v1/orchestrator/schedule-defaults", { epoch })).status).toBe(400);
  expect(after.enabled).toBe(true);
  expect(after.next_run).not.toBeNull();
  const K = makeCore(k, team, cleanups, { clock: () => wall.value });
  feed(K, A.store.queryEvents({ limit: 1000 }).map((row) => JSON.parse(row.json)).sort((x, y) => x.seq - y.seq));
  const signedLease = await post("/peer/v1/orchestrator/lease", signSchedulePeer(K, "lease", {}));
  expect(signedLease.status).toBe(200);
  expect((await post("/peer/v1/orchestrator/schedule-defaults",
    signSchedulePeer(K, "schedule-defaults", { epoch }))).status).toBe(200);
  const realRun = randomUUID();
  const signedClaim = await post("/peer/v1/orchestrator/schedule-claim", signSchedulePeer(K,
    "schedule-claim", { schedule: x.id, slot: x.next_run, run: realRun, epoch }));
  expect(signedClaim.status).toBe(200);
  expect((signedClaim.body as { claimed?: boolean }).claimed).toBe(true);
  const signedProgress = await post("/peer/v1/orchestrator/schedule-progress", signSchedulePeer(K,
    "schedule-progress", { epoch, run_id: after.run_id,
      change: { op: "put", schedule: { ...after, run_id: realRun,
        last_run: wall.value, next_run: null, last_result: "ok" } } }));
  expect(signedProgress.status).toBe(200);
  expect(readSchedules(A).find((s) => s.id === x.id)?.next_run).toBeGreaterThan(x.next_run!);
});
