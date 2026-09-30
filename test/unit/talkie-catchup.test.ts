import { afterEach, expect, test } from "bun:test";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { uncoveredAuthority } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { noteAuthorityCatchingUp, Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { stubOf } from "../../src/protocol/header.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, ev, now, tnode } from "../helpers/events.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const PREFIX = "walkie-talkie-schedule:v1:";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

for (const role of ["member", "observer"] as const) test(`${role} junk stub cannot stall founding authority`, () => {
  const a = tnode("alex"), m = tnode("mia");
  const { team, create } = createTeam(a);
  const A = makeCore(a, team, cleanups);
  A.ingest(create, "local");
  A.emit("team.member", { login: m.login, handle: m.handle, role });
  A.emit("team.node", { node_id: m.keys.nodeId, login: m.login, hostname: m.hostname, pubkey: m.keys.pubkey, ip: "127.0.0.1" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  const junk = ev(team, m, "msg.post", { text: 5 } as never, { channel: SCHEDULE_CHANNEL });
  A.ingest(junk, "remote");
  expect(uncoveredAuthority(A)).toBeNull();
  const schedules = new Schedules(A, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} });
  expect(() => schedules.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "x" } }, "alex")).not.toThrow();
});

test("only fillable authority term stubs gate catch-up and founding alert is safe", () => {
  const a = tnode("alex"), m = tnode("mia");
  const { team, create } = createTeam(a);
  const A = makeCore(a, team, cleanups);
  A.ingest(create, "local");
  A.emit("team.member", { login: m.login, handle: m.handle, role: "owner" });
  A.emit("team.node", { node_id: m.keys.nodeId, login: m.login, hostname: m.hostname, pubkey: m.keys.pubkey, ip: "127.0.0.1" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "mia"] });
  const foreign = ev(team, m, "msg.post", { text: "unrelated" }, { channel: SCHEDULE_CHANNEL });
  A.store.insertStub(stubOf(foreign));
  expect(uncoveredAuthority(A)).toBeNull();
  const hidden = A.emit("msg.post", { text: "hidden" }, { channel: SCHEDULE_CHANNEL });
  A.store.replaceWithStub(stubOf(hidden), "junk", "hidden_cap");
  expect(uncoveredAuthority(A)).toBeNull();
  const own = A.emit("msg.post", { text: "missing" }, { channel: SCHEDULE_CHANNEL });
  A.store.replaceWithStub(stubOf(own));
  expect(uncoveredAuthority(A)).toBe(A.nodeId);
  const status = new Schedules(A, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} }).status();
  expect(status).toContain(a.hostname);
  expect(() => noteAuthorityCatchingUp(A, { id: ID, name: "Job" } as never, A.nodeId, now())).not.toThrow();
});

// Adapted from review/repro5-stuck-catching-up.test.ts: D's event reaches A but never B.
test("an unrelated offline origin never blocks the new authority", () => {
  const a = tnode("alex"), b = tnode("bea"), d = tnode("dee");
  const { team, create } = createTeam(a);
  const A = makeCore(a, team, cleanups);
  A.ingest(create, "local");
  const memberB = A.emit("team.member", { login: b.login, handle: b.handle, role: "owner" });
  const nodeB = A.emit("team.node", { node_id: b.keys.nodeId, login: b.login, hostname: b.hostname, pubkey: b.keys.pubkey, ip: "127.0.0.1" });
  const memberD = A.emit("team.member", { login: d.login, handle: d.handle, role: "owner" });
  const nodeD = A.emit("team.node", { node_id: d.keys.nodeId, login: d.login, hostname: d.hostname, pubkey: d.keys.pubkey, ip: "127.0.0.1" });
  const channel = A.emit("channel.upsert", { name: SCHEDULE_CHANNEL });

  // D's laptop vanishes after only A receives this event.
  const D = makeCore(d, team, cleanups);
  feed(D, [create, memberB, nodeB, memberD, nodeD, channel]);
  const dPost = D.emit("msg.post", { text: "hello" }, { channel: SCHEDULE_CHANNEL });
  A.ingest(dPost, "remote"); // only A ever learns of this event

  const slot = Math.floor(now() / 300_000) * 300_000;
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: a.handle, last_run: null, next_run: slot, last_result: null, failures: 0, run_id: null };
  const put = A.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) }, { channel: SCHEDULE_CHANNEL });

  // A transfers authority to B. A's watermark cites D's seq (1) because A itself has it - B does not.
  const transfer = A.emit("team.authority", { node_id: b.keys.nodeId });
  expect(A.authorityTransferWatermark?.[d.keys.nodeId]).toBe(1);

  const B = makeCore(b, team, cleanups);
  // B receives A's stream but never D's post.
  feed(B, [create, memberB, nodeB, memberD, nodeD, channel, put, transfer]);
  expect(B.authority).toBe(b.keys.nodeId);
  expect(B.store.vv()[d.keys.nodeId] ?? 0).toBe(0); // B never got D's event

  let mono = 0;
  const wall = { value: slot + 6 * 60_000 };
  const leadB = new Leadership({ core: B, preferred: () => B.nodeId, lost: () => {}, now: () => wall.value, monoNow: () => mono });
  mono = 34_000;
  const epochB = leadB.grant(B.nodeId).epoch;
  const attempt1 = leadB.claimFromPeer(B.nodeId, { schedule: ID, slot, run: "22222222-2222-4222-8222-222222222222", epoch: epochB });
  expect(attempt1.claimed).toBe(true);
});

test("an uncovered previous authority stream shows the machine and alert once after ten minutes", () => {
  const a = tnode("alex"), b = tnode("bea");
  const { team, create } = createTeam(a);
  const A = makeCore(a, team, cleanups);
  A.ingest(create, "local");
  const member = A.emit("team.member", { login: b.login, handle: b.handle, role: "owner" });
  const node = A.emit("team.node", { node_id: b.keys.nodeId, login: b.login, hostname: b.hostname,
    pubkey: b.keys.pubkey, ip: "127.0.0.1" });
  const channel = A.emit("channel.upsert", { name: SCHEDULE_CHANNEL });
  const general = A.emit("channel.upsert", { name: "general" });
  const slot = Math.floor(now() / 300_000) * 300_000;
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: a.handle, last_run: null, next_run: slot, last_result: "authority catching up", failures: 0, run_id: null };
  const put = A.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) }, { channel: SCHEDULE_CHANNEL });
  const predecessorPost = A.emit("msg.post", { text: "predecessor event" }, { channel: SCHEDULE_CHANNEL });
  const transfer = A.emit("team.authority", { node_id: b.keys.nodeId });
  const B = makeCore(b, team, cleanups);
  feed(B, [create, member, node, channel, general, put, predecessorPost, transfer]);
  expect(B.authority).toBe(B.nodeId);
  B.store.setVv(A.nodeId, put.seq); // Isolate the catch-up gate with an uncovered predecessor stream.
  expect(B.store.vv()[A.nodeId]).toBeLessThan(A.authorityTransferWatermark![A.nodeId]!);
  let mono = 0;
  const wall = { value: slot + 6 * 60_000 };
  const lead = new Leadership({ core: B, preferred: () => B.nodeId, lost: () => {},
    now: () => wall.value, monoNow: () => mono });
  mono = 34_000;
  const epoch = lead.grant(B.nodeId).epoch;
  const claim = { schedule: ID, slot, run: "22222222-2222-4222-8222-222222222222", epoch };
  expect(lead.claimFromPeer(B.nodeId, claim).reason).toBe("authority_catching_up");
  expect(B.store.queryEvents({ channel: "general", kinds: ["msg.post"], limit: 10 })).toHaveLength(0);
  wall.value += 10 * 60_000;
  expect(lead.claimFromPeer(B.nodeId, claim).reason).toBe("authority_catching_up");
  expect(lead.claimFromPeer(B.nodeId, claim).reason).toBe("authority_catching_up");
  const shown = B.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 10 });
  expect(shown.some((row) => row.json.includes(`authority catching up: waiting for ${a.hostname}'s events`))).toBe(false);
  const alerts = B.store.queryEvents({ channel: "general", kinds: ["msg.post"], limit: 10 });
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.json).toContain(`waiting for ${a.hostname}'s events`);
  B.store.setVv(A.nodeId, A.authorityTransferWatermark![A.nodeId]!);
  expect(lead.claimFromPeer(B.nodeId, claim).claimed).toBe(true);
});
