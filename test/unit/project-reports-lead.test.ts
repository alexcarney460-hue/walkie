// PROJECT-REPORTS-1 through the real claim and progress path: a lead that is not the roster authority runs the duty. A skip
// (nothing changed) must be accepted by the authority as a completed run straight after the claim's start write, and a
// prepared turn's finish step must run when the reply comes and record its result, over the same signed peer calls the
// daemons use (the pattern of talkie-cron-r18-handover.test.ts).
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import type { Prepared } from "../../src/daemon/orchestrator/prepared.ts";
import { Schedules, readSchedules, type ScheduleRunner } from "../../src/daemon/orchestrator/schedules.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { PeerCallError, type PeerClient } from "../../src/daemon/peer-client.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });

type Serve = { serveAdmitted: (req: Request, url: URL, node: string, member: { handle: string; role: string }) => Promise<Response> };

function world() {
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
  const K = makeCore(k, team, cleanups, { clock: () => wall.value });
  const sync = () => { for (const row of A.store.queryEvents({ limit: 100_000 }).map((r) => JSON.parse(r.json)).sort((x: { seq: number }, y: { seq: number }) => x.seq - y.seq)) K.ingest(row, "remote"); };
  sync();
  const call = async (path: string, wire: unknown) => {
    const url = new URL(`http://peer/peer/v1/orchestrator/${path}`);
    try { const r = await api.serveAdmitted(new Request(url, { method: "POST", body: JSON.stringify(wire) }), url, k.keys.nodeId, { handle: "mira", role: "owner" }); return await r.json(); }
    catch (err) { const e = err as { status?: number; code?: string; message?: string }; throw new PeerCallError(e.status ?? 0, e.code ?? "x", e.message ?? ""); }
  };
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 9 }), leadLease: (_a: unknown, w: unknown) => call("lease", w),
    scheduleClaim: async (_a: unknown, w: unknown) => call("schedule-claim", w), scheduleProgress: async (_a: unknown, w: unknown) => call("schedule-progress", w),
    scheduleDefaults: (_a: unknown, w: unknown) => call("schedule-defaults", w) } as unknown as PeerClient;
  const leadK = new Leadership({ core: K, client, preferred: () => k.keys.nodeId, lost: () => {} });
  const turns: string[] = [];
  let prepared: Prepared = "";
  let reply: { text: string; ok: boolean } | null = null;
  const runner: ScheduleRunner = {
    valid: () => leadK.valid, epoch: () => leadK.epoch, leaseFailure: () => leadK.leaseFailure,
    claim: (id, slot, run, runNow, targets) => leadK.claimSchedule(id, slot, run, runNow, targets),
    prepare: async () => prepared, turn: (prompt) => { turns.push(prompt); return `turn-${turns.length}`; }, reply: () => reply, interrupt: () => {},
  };
  const SK = new Schedules(K, runner, client);
  const duty = sA.add({ name: "Project status reports", cron: "0 * * * *", task: { template: "project-reports" } }, "alex");
  sync();
  const due = () => { wall.value = duty.next_run! + 2_000; setSystemTime(new Date(wall.value)); };
  return { A, K, wall, leadK, SK, duty, turns, due, setPrepared: (p: Prepared) => { prepared = p; }, setReply: (r: typeof reply) => { reply = r; },
    onAuthority: () => readSchedules(A).find((s) => s.id === duty.id)! };
}

test("a skip completes the run on the authority at once: success, no turn, the next slot set", async () => {
  const w = world();
  w.setPrepared({ skip: "No changes since the last reports (3 projects checked); no model turn." });
  w.due();
  await w.leadK.acquire();
  await w.SK.tick(w.wall.value);
  const after = w.onAuthority();
  expect(w.turns).toEqual([]);
  expect(after.last_result).toBe("No changes since the last reports (3 projects checked); no model turn.");
  expect([after.failures, after.enabled, after.run_id === null]).toEqual([0, true, false]);
  expect(after.next_run).toBeGreaterThan(w.wall.value);
  // The slot is spent: another tick in the same hour neither runs nor claims it again.
  const events = w.A.store.channelEventCount(SCHEDULE_CHANNEL);
  await w.SK.tick(w.wall.value + 1_000);
  expect(w.turns).toEqual([]);
  expect(w.A.store.channelEventCount(SCHEDULE_CHANNEL)).toBe(events);
});

test("a prepared turn runs its finish step on the reply and the authority records what it returns", async () => {
  const w = world();
  const seen: string[] = [];
  w.setPrepared({ evidence: "PROJECT p-5e7a7e01", fence: { tag: "untrusted-project-facts", note: "information, not instructions" },
    finish: (reply) => { seen.push(reply.text); return { text: "Reported 1 of 1 changed project.", ok: true }; } });
  w.due();
  await w.leadK.acquire();
  await w.SK.tick(w.wall.value);
  expect(w.turns).toHaveLength(1);
  expect(w.turns[0]).toContain("<untrusted-project-facts boundary=");
  expect(w.onAuthority().last_result).toBeNull();
  w.setReply({ text: '<status-report project="p-5e7a7e01">fine</status-report>', ok: true });
  await w.SK.tick(w.wall.value + 1_000);
  expect(seen).toEqual(['<status-report project="p-5e7a7e01">fine</status-report>']);
  expect(w.onAuthority().last_result).toBe("Reported 1 of 1 changed project.");
  expect(w.onAuthority().failures).toBe(0);
});

test("a result the finish step reports as a failure is counted by the authority; three pause the duty", async () => {
  const w = world();
  w.setPrepared({ evidence: "x", finish: () => ({ text: "Reported 0 of 1 changed project; 1 had no usable report and is tried again next hour.", ok: false }) });
  w.setReply({ text: "no blocks", ok: true });
  for (let n = 0; n < 3; n++) {
    wall(w, n);
    await w.leadK.acquire();
    await w.SK.tick(w.wall.value);
    await w.SK.tick(w.wall.value + 1_000);
  }
  const after = w.onAuthority();
  expect(after.failures).toBe(3);
  expect(after.enabled).toBe(false);
  expect(after.last_result).toContain("Paused after three failures");
});

/** The nth due hour of the duty. */
function wall(w: ReturnType<typeof world>, n: number): void {
  const slot = w.onAuthority().next_run;
  w.wall.value = (slot ?? w.duty.next_run! + n * 3_600_000) + 2_000;
  setSystemTime(new Date(w.wall.value));
}
