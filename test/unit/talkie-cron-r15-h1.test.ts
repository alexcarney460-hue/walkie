// R14 attack 2 (handover): the successor authority's "caught up" test is the version vector, which counts STUBS.
// A newly promoted owner held only stubs of #talkie-schedules (it was not a member). The r14 repair adds it to the
// channel, stubs fill later in (origin, seq) order, 1,000 per sync round. If authority moves to it inside that
// window it decides claims, defaults and writes from a partial view. Real Cores; nothing in the repo is modified.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules, noteAuthorityCatchingUp, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { uncoveredAuthority } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore } from "../../test/helpers/core.ts";
import { createTeam, now, tnode } from "../../test/helpers/events.ts";
import { stubOf } from "../../src/protocol/header.ts";

const CLAIM = "walkie-talkie-claim:v1:";
const PUT = "walkie-talkie-schedule:v1:";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });

function allEvents(core: Core): Event[] {
  return core.store.queryEvents({ limit: 1_000_000 }).map((row) => JSON.parse(row.json) as Event).sort((a, b) => a.seq - b.seq);
}
function scheduleRows(core: Core) {
  return core.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 1_000_000 })
    .map((row) => JSON.parse(row.json) as Event).sort((a, b) => a.seq - b.seq);
}
function claimsFor(core: Core, id: string) {
  return scheduleRows(core).filter((e) => (e.body as { text: string }).text.startsWith(CLAIM))
    .map((e) => ({ origin: e.origin.slice(0, 6), ...JSON.parse((e.body as { text: string }).text.slice(CLAIM.length)) }))
    .filter((c) => c.schedule === id && !c.reset).map((c) => `${c.origin}:${new Date(c.slot).toISOString()}`);
}
const stubCount = (core: Core) => (core.store as unknown as { db: { query: (s: string) => { get: (...a: unknown[]) => { n: number } } } })
  .db.query("SELECT COUNT(*) AS n FROM events WHERE channel = ? AND redacted = 1").get(SCHEDULE_CHANNEL).n;

function setup() {
  const a = tnode("alex"), k = tnode("mira");
  const { team, create } = createTeam(a);
  const base = Math.floor(now() / 3_600_000) * 3_600_000 + 3_600_000;
  const wall = { value: base - 2 * 60_000 };
  setSystemTime(new Date(wall.value));
  const A = makeCore(a, team, cleanups, { clock: () => wall.value });
  A.ingest(create, "local");
  A.emit("team.member", { login: k.login, handle: k.handle, role: "member" });   // mira starts as a member
  A.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname, pubkey: k.keys.pubkey, ip: "127.0.0.1" });
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex"] });
  const K = makeCore(k, team, cleanups, { clock: () => wall.value });
  const mono = { v: 34_000 };
  const leadA = new Leadership({ core: A, preferred: () => A.nodeId, lost: () => {}, now: () => wall.value, monoNow: () => mono.v });
  const epochA = { v: leadA.grant(A.nodeId).epoch };
  const turnsA: string[] = [], readyA = { v: false };
  const sA = new Schedules(A, { valid: () => true, epoch: () => epochA.v,
    claim: async (id, slot, run, runNow) => leadA.claimFromPeer(A.nodeId, { schedule: id, slot, run, epoch: epochA.v, ...(runNow ? { run_now: true } : {}) }),
    turn: (p, id) => { turnsA.push(p); return `turn-${id}`; }, reply: () => readyA.v ? { text: "done", ok: true } : null, interrupt: () => {} });
  return { a, k, A, K, wall, base, mono, sA, turnsA, readyA, leadA, epochA };
}

async function runSlots(t: ReturnType<typeof setup>, slots: number[]) {
  for (const slot of slots) {
    t.wall.value = slot + 10_000; setSystemTime(new Date(t.wall.value)); t.readyA.v = false; await t.sA.tick(t.wall.value);
    t.wall.value += 20_000; setSystemTime(new Date(t.wall.value)); t.readyA.v = true; await t.sA.tick(t.wall.value);
  }
}

function promoteAndTransfer(t: ReturnType<typeof setup>, fill: (e: Event) => boolean) {
  const { A, K, k } = t;
  // What A's peer API serves a non-member (peer-api.ts:459): stubs for #talkie-schedules, full events elsewhere.
  for (const e of allEvents(A)) K.ingest((e.channel === SCHEDULE_CHANNEL ? stubOf(e) : e) as Event, "remote");
  const stubs = stubCount(K);
  A.emit("team.member", { login: k.login, handle: k.handle, role: "owner" });
  return { stubs, after: async () => {
    await t.sA.ensureChannel();                                // r14 repair: adds the promoted owner
    const others = () => allEvents(A).filter((e) => e.channel !== SCHEDULE_CHANNEL);
    feed(K, others());
    const partial = scheduleRows(A).filter(fill);
    feed(K, partial);                                          // the first fill page(s): oldest seqs first
    A.emit("team.authority", { node_id: K.nodeId });
    feed(K, others());
  } };
}

test("H1a successor with a partial stub fill refuses a duplicate slot", async () => {
  const t = setup();
  const x = t.sA.add({ name: "Invoice sweep", cron: "*/5 * * * *", task: { prompt: "SEND THE INVOICE SWEEP" } }, "alex");
  const s0 = x.next_run!;
  await runSlots(t, [s0, s0 + 300_000]);                        // A runs S0 and S1
  console.log(`H1a A ran: turns=${t.turnsA.length}; A claims: ${JSON.stringify(claimsFor(t.A, x.id))}`);
  const firstPut = scheduleRows(t.A).find((e) => (e.body as { text: string }).text.startsWith(PUT))!;
  const p = promoteAndTransfer(t, (e) => e.id === firstPut.id);
  await p.after();
  const { K } = t;
  console.log(`H1a K stubs before promotion=${p.stubs}; stubs left after partial fill=${stubCount(K)}; K authority=${K.isAuthority()}; uncoveredAuthority(K)=${uncoveredAuthority(K)}`);
  console.log("H1a K view:", JSON.stringify(readSchedules(K).map((s) => ({ name: s.name, next_run: new Date(s.next_run!).toISOString(), last_run: s.last_run }))));
  // K is the new authority and (as is common) the lead.
  t.wall.value = s0 + 2 * 300_000 + 60_000; setSystemTime(new Date(t.wall.value));
  const leadK = new Leadership({ core: K, preferred: () => K.nodeId, lost: () => {}, now: () => t.wall.value, monoNow: () => t.mono.v });
  t.mono.v += 400_000;
  const epochK = { v: leadK.grant(K.nodeId).epoch };
  const turnsK: string[] = [];
  const sK = new Schedules(K, { valid: () => true, epoch: () => epochK.v,
    claim: async (id, slot, run, runNow) => leadK.claimFromPeer(K.nodeId, { schedule: id, slot, run, epoch: epochK.v, ...(runNow ? { run_now: true } : {}) }),
    turn: (pr, id) => { turnsK.push(pr); return `turn-${id}`; }, reply: () => null, interrupt: () => {} });
  await sK.tick(t.wall.value);
  feed(K, scheduleRows(t.A));                                   // the rest of the fill arrives
  const claims = claimsFor(K, x.id);
  console.log(`H1a K turns=${turnsK.length}; all claims for the id after fill: ${JSON.stringify(claims)}`);
  const s0iso = new Date(s0).toISOString();
  expect(turnsK.length).toBe(0);
  expect(claims.filter((c) => c.endsWith(s0iso)).length).toBe(1);   // S0 claimed by A AND by K: ran twice
});

test("H1b successor with no fill waits and keeps one set of defaults", async () => {
  const t = setup();
  await t.sA.defaults();                                          // A created the defaults long ago
  const before = readSchedules(t.A).map((s) => s.name);
  const p = promoteAndTransfer(t, () => false);
  await p.after();
  const { K } = t;
  console.log(`H1b K stubs=${stubCount(K)}; channelEventCount(K)=${K.store.channelEventCount(SCHEDULE_CHANNEL)}; uncovered=${uncoveredAuthority(K)}`);
  t.wall.value += 60_000; setSystemTime(new Date(t.wall.value));
  const leadK = new Leadership({ core: K, preferred: () => K.nodeId, lost: () => {}, now: () => t.wall.value, monoNow: () => t.mono.v });
  t.mono.v += 400_000;
  const epochK = leadK.grant(K.nodeId).epoch;
  const sK = new Schedules(K, { valid: () => true, epoch: () => epochK, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} });
  await sK.tick(t.wall.value);
  feed(K, scheduleRows(t.A));
  const after = readSchedules(K).map((s) => s.name).sort();
  console.log("H1b A before:", JSON.stringify(before), "| K after tick + full fill:", JSON.stringify(after));
  // One set: the eight built-in duties (TALKIE-OPS-1 added the orchestration poll and the card curation), each once.
  expect(after.length).toBe(8);
  expect(new Set(after).size).toBe(after.length);
});

test("H1c catch-up status and refused management never restore an unseen predecessor pause", async () => {
  const t = setup();
  const added = t.sA.add({ name: "Paused", cron: "*/5 * * * *", task: { prompt: "x" } }, "alex");
  t.sA.edit(added.id, { enabled: false });
  const firstPut = scheduleRows(t.A).find((event) => (event.body as { text: string }).text.startsWith(PUT))!;
  const transfer = promoteAndTransfer(t, (event) => event.id === firstPut.id);
  await transfer.after();
  const stale = readSchedules(t.K)[0]!;
  expect(stale.enabled).toBe(true);
  const before = t.K.store.channelEventCount(SCHEDULE_CHANNEL);
  noteAuthorityCatchingUp(t.K, stale, t.A.nodeId, t.wall.value);
  expect(t.K.store.channelEventCount(SCHEDULE_CHANNEL)).toBe(before);
  const successor = new Schedules(t.K, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} });
  expect(() => successor.manage({ op: "edit", id: added.id, input: { name: "Stale" },
    handle: "mira", machine: t.K.hostname, audit_id: "22222222-2222-4222-8222-222222222222" }))
    .toThrow("catching up");
  expect(() => successor.reset(added.id, t.wall.value)).toThrow("catching up");
  expect(t.K.store.channelEventCount(SCHEDULE_CHANNEL)).toBe(before);
  feed(t.K, scheduleRows(t.A));
  expect(readSchedules(t.K)[0]?.enabled).toBe(false);
  expect(readSchedules(t.K)[0]?.name).toBe("Paused");
});
