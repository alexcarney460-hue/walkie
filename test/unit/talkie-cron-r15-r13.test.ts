// The round-13 probes (cron-probe-r13/b1*, b3) re-expressed for the r14 API: mira's changes are forwarded requests
// that the authority decides (Schedules.manage with handle mira), mira's lead writes run progress through the
// authority. Each test prints the state after demotion / revocation / restart. The probes run against the current tree.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { loadScheduleClaims } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { SignedSchedulePeer, verifySchedulePeer } from "../../src/daemon/orchestrator/schedule-forward.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { PeerClient } from "../../src/daemon/peer-client.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { ScheduleProgress } from "../../src/protocol/talkie-management.ts";
import { feed, makeCore } from "../../test/helpers/core.ts";
import { createTeam, now, tnode } from "../../test/helpers/events.ts";

const CLAIM_PREFIX = "walkie-talkie-claim:v1:";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });

function team() {
  const a = tnode("alex"), k = tnode("mira");
  const { team, create } = createTeam(a);
  const base = Math.floor(now() / 3_600_000) * 3_600_000 + 3_600_000;
  const wall = { value: base - 2 * 60_000 };
  setSystemTime(new Date(wall.value));
  const A = makeCore(a, team, cleanups, { clock: () => wall.value });
  A.ingest(create, "local");
  const out = [
    A.emit("team.member", { login: k.login, handle: k.handle, role: "owner" }),
    A.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname, pubkey: k.keys.pubkey, ip: "127.0.0.1" }),
    A.emit("channel.upsert", { name: "general" }),
    A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "mira"] }),
  ];
  const K = makeCore(k, team, cleanups, { clock: () => wall.value });
  feed(K, [create, ...out]);
  const mono = { v: 34_000 };
  const pref = { v: A.nodeId };
  const lead = new Leadership({ core: A, preferred: () => pref.v, lost: () => {}, now: () => wall.value, monoNow: () => mono.v });
  const epoch = { v: lead.grant(A.nodeId).epoch };
  return { A, K, a, k, wall, base, lead, epoch, mono, pref };
}
const byMira = (A: Core) => ({ handle: "mira", machine: "mira-mbp", audit_id: randomUUID() });
const byAlex = (A: Core) => ({ handle: "alex", machine: A.hostname, audit_id: randomUUID() });
function runnerOn(node: Core, lead: Leadership, epoch: { v: number }, turns: string[], ready: { v: boolean }) {
  return { valid: () => true, epoch: () => epoch.v, turn: (p: string, id: string) => { turns.push(p); return `turn-${id}`; },
    reply: () => ready.v ? { text: "done", ok: true } : null, interrupt: () => {},
    claim: async (id: string, slot: number, run: string, runNow?: boolean) => lead.claimFromPeer(node.nodeId, { schedule: id, slot, run, epoch: epoch.v, ...(runNow ? { run_now: true } : {}) }) };
}
const view = (core: Core) => readSchedules(core).map((s) => ({ name: s.name, enabled: s.enabled, prompt: "prompt" in s.task ? s.task.prompt : s.task.template }));
const claimSlots = (core: Core, id: string) => core.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 1_000_000 })
  .map((row) => (JSON.parse(row.json) as { body: { text: string } }).body.text)
  .filter((text) => text.startsWith(CLAIM_PREFIX)).map((text) => JSON.parse(text.slice(CLAIM_PREFIX.length)))
  .filter((c) => c.schedule === id && !c.reset).map((c) => new Date(c.slot).toISOString());

test("B1a' demoting a co-owner keeps Alex's pause/remove and Mira's earlier edits", async () => {
  const { A, K, k, wall, base, lead, epoch } = team();
  const turns: string[] = [], ready = { v: false };
  const sA = new Schedules(A, runnerOn(A, lead, epoch, turns, ready));
  const s = sA.manage({ op: "add", ...byAlex(A), input: { name: "Nightly", cron: "*/5 * * * *", task: { prompt: "ORIGINAL PROMPT" } } }).schedule!;
  const t = sA.manage({ op: "add", ...byAlex(A), input: { name: "Temp", cron: "*/5 * * * *", task: { prompt: "TEMP (Alex removed this)" } } }).schedule!;
  for (let i = 0; i < 4; i++) sA.manage({ op: "edit", id: s.id, ...byMira(A), input: { task: { prompt: i === 3 ? "MIRA'S SAFER PROMPT" : `mira draft ${i}` } } });
  sA.manage({ op: "add", ...byMira(A), input: { name: "Mira's report", cron: "0 * * * *", task: { prompt: "MIRA REPORT" } } });
  sA.manage({ op: "edit", id: s.id, ...byAlex(A), input: { enabled: false } });
  sA.manage({ op: "remove", id: t.id, ...byAlex(A) });
  const before = view(A);
  A.emit("team.member", { login: k.login, handle: k.handle, role: "member" });
  const after = view(A);
  console.log("B1a' before:", JSON.stringify(before), "\nB1a' after demotion:", JSON.stringify(after));
  wall.value = base + 10_000; setSystemTime(new Date(wall.value));
  await sA.tick(wall.value);
  console.log("B1a' turns:", JSON.stringify(turns.map((p) => p.includes("ORIGINAL") ? "ORIGINAL" : p.includes("TEMP") ? "TEMP" : p.includes("MIRA REPORT") ? "MIRA REPORT" : p.includes("SAFER") ? "SAFER" : "?")));
  expect(after).toEqual(before);
  expect(turns.some((p) => p.includes("ORIGINAL") || p.includes("TEMP"))).toBe(false);
  void K;
});

test("B1b'/B1d' remove, 49 h prune, authority restart, revoke Mira's old machine: no resurrection, no second run", async () => {
  const t0 = team();
  const { A, K, k, wall, mono } = t0;
  let lead = t0.lead; const epoch = t0.epoch;
  const turns: string[] = [], ready = { v: false };
  const r = { ...runnerOn(A, lead, epoch, turns, ready), claim: async (id: string, slot: number, run: string) => lead.claimFromPeer(A.nodeId, { schedule: id, slot, run, epoch: epoch.v }) };
  const sA = new Schedules(A, r);
  const s = sA.manage({ op: "add", ...byAlex(A), input: { name: "Invoice sweep", cron: "*/5 * * * *", task: { prompt: "SEND THE INVOICE SWEEP" } } }).schedule!;
  const slot0 = s.next_run!;
  for (let i = 0; i < 6; i++) sA.manage({ op: "edit", id: s.id, ...byMira(A), input: { name: i === 5 ? "Invoice sweep" : `Invoice sweep ${i}` } });
  wall.value = slot0 + 10_000; setSystemTime(new Date(wall.value));
  await sA.tick(wall.value);
  ready.v = true; wall.value += 20_000; setSystemTime(new Date(wall.value));
  await sA.tick(wall.value);
  ready.v = false;
  sA.manage({ op: "remove", id: s.id, ...byAlex(A) });
  wall.value += 49 * 3_600_000; setSystemTime(new Date(wall.value));
  epoch.v = lead.grant(A.nodeId).epoch;
  console.log("B1b' stored claims for the removed id after 49 h:", loadScheduleClaims(A, A.authorityLeaseTerm).filter((c) => c.schedule === s.id).length);
  lead = new Leadership({ core: A, preferred: () => A.nodeId, lost: () => {}, now: () => wall.value, monoNow: () => mono.v });
  mono.v += 200_000; epoch.v = lead.grant(A.nodeId).epoch;
  A.emit("team.node", { node_id: K.nodeId, login: k.login, hostname: k.hostname, pubkey: k.keys.pubkey, ip: "127.0.0.1", revoked: true });
  const back = readSchedules(A).find((x) => x.id === s.id);
  let readd = "";
  try { sA.manage({ op: "edit", id: s.id, ...byAlex(A), input: { enabled: true } }); readd = "edit accepted"; } catch (err) { readd = String(err).slice(0, 80); }
  await sA.tick(wall.value);
  const direct = lead.claimFromPeer(A.nodeId, { schedule: s.id, slot: slot0, run: "00000000-0000-4000-8000-00000000abcd", epoch: epoch.v });
  console.log(`B1b' after revoke: listed=${JSON.stringify(back ?? null)}; edit of removed id: ${readd}; turns=${turns.length}; claims=${JSON.stringify(claimSlots(A, s.id))}; direct claim slot0: ${JSON.stringify(direct)}`);
  expect(back).toBeUndefined();
  expect(turns.length).toBe(1);
  expect(direct.claimed).toBe(false);
});

test("B1c' demotion then an unrelated rename keeps the pause", async () => {
  const { A, k, wall, base, lead, epoch } = team();
  const turns: string[] = [], ready = { v: false };
  const sA = new Schedules(A, runnerOn(A, lead, epoch, turns, ready));
  const s = sA.manage({ op: "add", ...byAlex(A), input: { name: "Nightly", cron: "*/5 * * * *", task: { prompt: "ORIGINAL PROMPT" } } }).schedule!;
  sA.manage({ op: "edit", id: s.id, ...byMira(A), input: { task: { prompt: "MIRA PROMPT" } } });
  sA.manage({ op: "edit", id: s.id, ...byAlex(A), input: { enabled: false } });
  A.emit("team.member", { login: k.login, handle: k.handle, role: "member" });
  sA.manage({ op: "edit", id: s.id, ...byAlex(A), input: { name: "Nightly (renamed)" } });
  wall.value = base + 10_000; setSystemTime(new Date(wall.value));
  await sA.tick(wall.value);
  console.log(`B1c' final: ${JSON.stringify(view(A))}; turns=${turns.length}; claims=${JSON.stringify(claimSlots(A, s.id))}`);
  expect(view(A)).toEqual([{ name: "Nightly (renamed)", enabled: false, prompt: "MIRA PROMPT" }]);
  expect(turns.length).toBe(0);
});

test("B1e' Mira's laptop leads (progress forwarded to the authority), then is revoked: schedule and history intact", async () => {
  const { A, K, k, wall, base, lead, epoch, mono, pref } = team();
  const turns: string[] = [], ready = { v: false };
  const sA = new Schedules(A, runnerOn(A, lead, epoch, turns, ready));
  const s = sA.manage({ op: "add", ...byMira(A), input: { name: "Board refresh", cron: "*/5 * * * *", task: { template: "board-refresh" } } }).schedule!;
  const sync = () => feed(K, A.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 100_000 }).map((r) => JSON.parse(r.json) as Event).sort((x, y) => x.seq - y.seq));
  sync();
  pref.v = K.nodeId; mono.v += 200_000; epoch.v = lead.grant(K.nodeId).epoch;
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 1 }),
    scheduleProgress: async (_addr: unknown, wire: SignedSchedulePeer) => sA.progress(K.nodeId,
      verifySchedulePeer(A, K.nodeId, "schedule-progress", wire, ScheduleProgress), (n, e) => lead.holds(n, e)) } as unknown as PeerClient;
  const sK = new Schedules(K, runnerOn(K, lead, epoch, turns, ready), client);
  for (let i = 0; i < 3; i++) {
    wall.value = base + i * 300_000 + 10_000; setSystemTime(new Date(wall.value)); ready.v = false; await sK.tick(wall.value); sync();
    wall.value += 20_000; setSystemTime(new Date(wall.value)); ready.v = true; await sK.tick(wall.value); sync();
  }
  const origins = A.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 100_000 }).map((r) => r.origin === A.nodeId ? "A" : "K");
  const before = readSchedules(A);
  A.emit("team.node", { node_id: K.nodeId, login: k.login, hostname: k.hostname, pubkey: k.keys.pubkey, ip: "127.0.0.1", revoked: true });
  console.log(`B1e' K turns=${turns.length}; post origins=${JSON.stringify([...new Set(origins)])}; claims=${JSON.stringify(claimSlots(A, s.id))}; last_result=${JSON.stringify(before[0]?.last_result)}; intact after revoke: ${JSON.stringify(readSchedules(A)) === JSON.stringify(before)}`);
  expect(turns.length).toBe(3);
  expect(readSchedules(A)).toEqual(before);
});
