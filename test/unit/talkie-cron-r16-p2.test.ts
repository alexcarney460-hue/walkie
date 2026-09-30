// R15 attack 1: the node-key signature on forwarded management. (a) replay of one signed request to the NEXT
// authority inside the two-minute window: decisions are persisted only in the old authority's meta, and the signature
// does not bind the authority or its term. (b) what a legitimate owner with a skewed clock sees. Real Cores and the
// real PeerApi handler; nothing in the repo is modified.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { signScheduleManagement } from "../../src/daemon/orchestrator/schedule-forward.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { uncoveredAuthority } from "../../src/daemon/orchestrator/schedule-claims.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore } from "../../test/helpers/core.ts";
import { createTeam, now, tnode } from "../../test/helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };
type Serve = { serveAdmitted: (req: Request, url: URL, node: string, member: { handle: string; role: string }) => Promise<Response> };
function allEvents(core: Core): Event[] {
  return core.store.queryEvents({ limit: 1_000_000 }).map((row) => JSON.parse(row.json) as Event).sort((a, b) => a.seq - b.seq);
}
function hostAndCall(core: Core, caller: string) {
  const schedules = new Schedules(core, idle);
  registerHost(core, { schedules, holdsScheduleLease: () => false } as unknown as OrchestratorHost);
  const api = new PeerApi(core) as unknown as Serve;
  return async (body: unknown) => {
    const url = new URL("http://peer/peer/v1/orchestrator/schedule-manage");
    try { const r = await api.serveAdmitted(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, caller, { handle: "mira", role: "owner" }); return { status: r.status, body: await r.json() }; }
    catch (err) { const e = err as { status?: number; code?: string; message?: string }; return { status: e.status, code: e.code, message: e.message?.slice(0, 120) }; }
  };
}

function setup() {
  const a = tnode("alex"), k = tnode("mira"), b = tnode("bea");
  const { team, create } = createTeam(a);
  setSystemTime(new Date(now()));
  const A = makeCore(a, team, cleanups);
  A.ingest(create, "local");
  for (const n of [k, b]) {
    A.emit("team.member", { login: n.login, handle: n.handle, role: "owner" });
    A.emit("team.node", { node_id: n.keys.nodeId, login: n.login, hostname: n.hostname, pubkey: n.keys.pubkey, ip: "127.0.0.1" });
  }
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "bea", "mira"] });
  const K = makeCore(k, team, cleanups), B = makeCore(b, team, cleanups);
  feed(K, allEvents(A)); feed(B, allEvents(A));
  return { A, K, B, k };
}

test("P2a signed add cannot replay to successor authority", async () => {
  const { A, K, B, k } = setup();
  const signed = signScheduleManagement(K, { op: "add", handle: "mira", machine: "ignored", audit_id: randomUUID(),
    input: { name: "Once", cron: "*/5 * * * *", task: { prompt: "SEND IT" } } });
  const onA = await hostAndCall(A, k.keys.nodeId)(signed);
  A.emit("team.authority", { node_id: B.nodeId });
  feed(B, allEvents(A));
  console.log(`P2a B authority=${B.isAuthority()} uncovered(B)=${uncoveredAuthority(B)} B lists before replay=${JSON.stringify(readSchedules(B).map((s) => s.name))}`);
  const onB = await hostAndCall(B, k.keys.nodeId)(signed);   // same bytes, same audit_id, 0 s later
  const names = readSchedules(B).map((s) => s.name);
  const audits = B.store.queryEvents({ channel: "general", kinds: ["msg.post"], limit: 100 })
    .map((r) => (JSON.parse(r.json) as { body: { text: string } }).body.text).filter((t) => t.includes(signed.audit_id));
  console.log(`P2a A: ${onA.status}; B: ${onB.status}; B lists ${JSON.stringify(names)}; audit posts for that audit_id on B: ${audits.length}`);
  expect(onA.status).toBe(200);
  expect(onB.status).toBe(409);
  expect(onB.code).toBe("not_authority");
  expect(names.filter((n) => n === "Once").length).toBe(1);
});

test("P2c inside the window: a new audit_id, another requester field, a stripped agent, all under the old signature", async () => {
  const { A, K, k } = setup();
  const signed = signScheduleManagement(K, { op: "add", handle: "mira", machine: "ignored", audit_id: randomUUID(), agent: "claude-code",
    input: { name: "Sig", cron: "*/5 * * * *", task: { prompt: "x" } } });
  const call = hostAndCall(A, k.keys.nodeId);
  const newAudit = await call({ ...signed, audit_id: randomUUID() });
  const noAgent = await call({ ...signed, body: { input: (signed.body as { input: unknown }).input } });
  const later = await call({ ...signed, ts: signed.ts + 1 });
  console.log("P2c new audit_id:", JSON.stringify(newAudit), "| agent stripped:", JSON.stringify(noAgent), "| ts+1:", JSON.stringify(later));
  expect([newAudit.status, noAgent.status, later.status]).toEqual([403, 403, 403]);
  expect(readSchedules(A)).toHaveLength(0);
});

test("P2b a legitimate owner whose clock is 3 minutes slow", async () => {
  const { A, K, k } = setup();
  const t0 = Date.now();
  setSystemTime(new Date(t0 - 180_000));
  const signed = signScheduleManagement(K, { op: "add", handle: "mira", machine: "ignored", audit_id: randomUUID(),
    input: { name: "Skewed", cron: "*/5 * * * *", task: { prompt: "x" } } });
  setSystemTime(new Date(t0));
  const r = await hostAndCall(A, k.keys.nodeId)(signed);
  console.log("P2b skewed owner sees:", JSON.stringify(r));
  expect(r.status).toBe(403);
  expect(r.code).toBe("clock_skew");
  expect(r.message).toContain("180000 ms");
});
