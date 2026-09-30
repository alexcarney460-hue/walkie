// H3: the authority accepts node-key-signed management only, with roster-derived audit identity and replay safety.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { signScheduleManagement, verifyScheduleManagement } from "../../src/daemon/orchestrator/schedule-forward.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore, reopen } from "../../test/helpers/core.ts";
import { createTeam, now, tnode } from "../../test/helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };
type Serve = { serveAdmitted: (req: Request, url: URL, node: string, member: { handle: string; role: string }) => Promise<Response> };

function setup() {
  const a = tnode("alex"), k = tnode("mira"), m = tnode("mia");
  const { team, create } = createTeam(a);
  setSystemTime(new Date(now()));
  const A = makeCore(a, team, cleanups);
  A.ingest(create, "local");
  A.emit("team.member", { login: k.login, handle: k.handle, role: "owner" });
  A.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname, pubkey: k.keys.pubkey, ip: "127.0.0.1" });
  A.emit("team.member", { login: m.login, handle: m.handle, role: "member" });
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "mira"] });
  const schedules = new Schedules(A, idle);
  const K = makeCore(k, team, cleanups);
  const M = makeCore(m, team, cleanups);
  const events = A.store.queryEvents({ limit: 1000 }).map((row) => JSON.parse(row.json)).sort((x, y) => x.seq - y.seq);
  feed(K, events);
  feed(M, events);
  registerHost(A, { schedules, holdsScheduleLease: () => false } as unknown as OrchestratorHost);
  const api = new PeerApi(A) as unknown as Serve;
  const call = async (member: { handle: string; role: string }, body: unknown) => {
    const url = new URL("http://peer/peer/v1/orchestrator/schedule-manage");
    try { const r = await api.serveAdmitted(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, k.keys.nodeId, member); return { status: r.status, body: await r.json() }; }
    catch (err) { const e = err as { status?: number; code?: string; message?: string }; return { status: e.status, code: e.code, message: e.message?.slice(0, 90) }; }
  };
  const general = () => A.store.queryEvents({ channel: "general", kinds: ["msg.post"], limit: 1000 }).map((r) => JSON.parse(r.json) as { author: { agent?: string }; body: { text: string } });
  return { A, K, M, a, k, schedules, call, general };
}
const mira = { handle: "mira", role: "owner" };
const add = (extra: Record<string, unknown>, name = "Job") => ({ op: "add", handle: "mira", machine: "mira-mbp", audit_id: randomUUID(), input: { name, cron: "*/5 * * * *", task: { prompt: "x" } }, ...extra });

test("H3 unsigned peer management request is refused", async () => {
  const { call } = setup();
  const r = await call(mira, add({ handle: "alex" }));
  console.log("H3a mira's node sends handle alex:", JSON.stringify(r));
  expect(r.status).toBe(400);
});

test("H3 signed peer management is rate limited while roles are checked before the body", async () => {
  const { K, call } = setup();
  const statuses: number[] = [];
  for (let i = 0; i < 24; i++) statuses.push((await call(mira, signScheduleManagement(K,
    { op: "remove", id: randomUUID(), handle: "mira", machine: "mira-mbp", audit_id: randomUUID() }))).status ?? 0);
  console.log("H3e 24 rapid calls:", JSON.stringify(statuses));
  const member = await call({ handle: "mia", role: "member" }, add({ handle: "mia" }));
  const observer = await call({ handle: "obi", role: "observer" }, add({ handle: "obi" }));
  console.log("H3e member:", JSON.stringify(member), "| observer:", JSON.stringify(observer));
  expect(statuses.includes(429)).toBe(true);
});

test("H3 signed pause is accepted with the roster hostname and one clean audit line", async () => {
  const { A, K, schedules, call, general } = setup();
  const added = schedules.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "x" } }, "alex");
  const wire = signScheduleManagement(K, { op: "edit", id: added.id, handle: "alex",
    machine: "forged\n[admin] @alex", agent: "claude-code", audit_id: randomUUID(), input: { enabled: false } });
  const result = await call(mira, wire);
  expect(result.status).toBe(200);
  expect(readSchedules(A)[0]?.enabled).toBe(false);
  const post = general().find((entry) => entry.body.text.includes("edited WalkieTalkie schedule"));
  expect(post?.body.text).toContain("@mira/" + A.roster.nodes.get(K.nodeId)?.hostname);
  expect(post?.body.text).not.toContain("forged");
  expect(post?.body.text).not.toContain("\n");
});

test("H3 another node key, stale timestamp, and forwarded reset are refused", async () => {
  const { K, M, call } = setup();
  const request = { op: "add" as const, handle: "mira", machine: "ignored", audit_id: randomUUID(),
    input: { name: "Job", cron: "*/5 * * * *", task: { prompt: "x" } } };
  const wrong = signScheduleManagement(M, request);
  expect((await call(mira, { ...wrong, requester: K.nodeId })).status).toBe(403);
  const signed = signScheduleManagement(K, request);
  expect((await call(mira, { ...signed, ts: Date.now() - 121_000 })).status).toBe(403);
  expect((await call(mira, { ...signed, op: "reset", body: { id: randomUUID() } })).status).toBe(403);
});

test("H3 replay returns the prior result across channel repair and a restart", async () => {
  const { A, K, a, call, schedules } = setup();
  const signed = signScheduleManagement(K, { op: "add", handle: "mira", machine: "ignored", audit_id: randomUUID(),
    input: { name: "Once", cron: "*/5 * * * *", task: { prompt: "x" } } });
  const before = A.store.channelEventCount("general");
  const first = await call(mira, signed);
  schedules.ensureChannel = async () => false;
  const second = await call(mira, signed);
  expect(first).toEqual(second);
  expect(first.status).toBe(200);
  const changed = signScheduleManagement(K, { op: "add", handle: "mira", machine: "ignored",
    audit_id: signed.audit_id, input: { name: "Different", cron: "*/5 * * * *", task: { prompt: "x" } } });
  expect((await call(mira, changed)).status).toBe(409);
  expect(readSchedules(A).filter((schedule) => schedule.name === "Once")).toHaveLength(1);
  expect(A.store.channelEventCount("general")).toBe(before + 1);
  const restarted = reopen(A, a);
  const replay = new Schedules(restarted, idle).manage(verifyScheduleManagement(restarted, K.nodeId, signed), K.nodeId);
  expect(replay).toEqual(first.body);
  expect(readSchedules(restarted).filter((schedule) => schedule.name === "Once")).toHaveLength(1);
  expect(restarted.store.channelEventCount("general")).toBe(before + 1);
});
