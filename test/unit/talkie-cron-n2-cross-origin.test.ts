// N2: two real Cores. The roster authority (alex) is not the WalkieTalkie lease holder (hina). Hina's clock runs
// 3 h ahead, so her durable schedule put carries last_run and ts 3 h in the future. Alex's claims then report
// clock_error; a person resets on the authority. Does the reset recover the schedule?
import { afterEach, expect, test } from "bun:test";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL, nextRuns } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const PREFIX = "walkie-talkie-schedule:v1:";
const CLAIM_PREFIX = "walkie-talkie-claim:v1:";
const MIN = 60_000, HOUR = 60 * MIN;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

test("N2 a lease holder's raw future-stamped put is ignored and the authority reset recovers", () => {
  const a = tnode("alex"), h = tnode("hina");
  const { team, create } = createTeam(a);
  const S0 = Math.floor(now() / 300_000) * 300_000 + 600_000;
  const wallA = { value: S0 - MIN }, wallH = { value: S0 - MIN };
  const A = makeCore(a, team, cleanups, { clock: () => wallA.value });
  A.ingest(create, "local");
  const out = [
    A.emit("team.member", { login: h.login, handle: h.handle, role: "owner" }),
    A.emit("team.node", { node_id: h.keys.nodeId, login: h.login, hostname: h.hostname, pubkey: h.keys.pubkey, ip: "127.0.0.1" }),
    A.emit("channel.upsert", { name: "general" }),
    A.emit("channel.upsert", { name: SCHEDULE_CHANNEL }),
  ];
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: a.handle, last_run: null, next_run: S0, last_result: null, failures: 0, run_id: null };
  out.push(A.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) }, { channel: SCHEDULE_CHANNEL }));
  const H = makeCore(h, team, cleanups, { clock: () => wallH.value });
  feed(H, [create, ...out]);
  expect(H.me()?.handle).toBe("hina");

  let mono = 0;
  const lead = new Leadership({ core: A, preferred: () => H.nodeId, lost: () => {}, now: () => wallA.value, monoNow: () => mono });
  mono = 34_000;
  const epoch = lead.grant(H.nodeId).epoch;

  // Real time S0. Hina's clock jumped 3 h ahead. She claims the due slot S0 (accepted) and writes her put.
  wallA.value = S0; wallH.value = S0 + 3 * HOUR;
  expect(lead.claimFromPeer(H.nodeId, { schedule: ID, slot: S0, run: RUN, epoch })).toMatchObject({ claimed: true });
  const claimed = { ...schedule, run_id: RUN, last_run: wallH.value, next_run: nextRuns(schedule.cron, wallH.value, 1)[0]! };
  const hput = H.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", schedule: claimed }) }, { channel: SCHEDULE_CHANNEL });
  console.log("N2 hina put ts - S0 =", (hput.ts - S0) / MIN, "min");
  feed(A, [hput]);
  const seenByA = readSchedules(A).find((s) => s.id === ID)!;
  expect(seenByA).toEqual(schedule);
  console.log("N2 authority view before reset: last_run=S0+" + (seenByA.last_run! - S0) / MIN + "m next_run=S0+" + (seenByA.next_run! - S0) / MIN + "m");

  // Real time S0+5m: hina's next claim => clock_error (the scenario reset exists for).
  wallA.value = S0 + 5 * MIN;
  const blocked = lead.claimFromPeer(H.nodeId, { schedule: ID, slot: seenByA.next_run!, run: "33333333-3333-4333-8333-333333333333", epoch });
  console.log("N2 before reset:", JSON.stringify(blocked));

  // Hina's clock is corrected. A person resets on the authority at real time S0+10m.
  wallH.value = S0 + 10 * MIN; wallA.value = S0 + 10 * MIN;
  const updated = new Schedules(A, { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} })
    .reset(ID, wallA.value);
  console.log("N2 reset returned next_run=S0+" + (updated.next_run! - S0) / MIN + "m last_run=" + updated.last_run);
  const claims = A.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 50 })
    .filter((r) => JSON.parse(r.json).body.text.startsWith(CLAIM_PREFIX));
  console.log("N2 reset floor = S0+" + (JSON.parse(JSON.parse(claims[0]!.json).body.text.slice(CLAIM_PREFIX.length)).refusal_floor - S0) / MIN + "m");
  const afterA = readSchedules(A).find((s) => s.id === ID)!;
  expect(afterA.last_run).toBeNull();
  expect(updated).toEqual(afterA);
  const resetPut = A.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 50 })
    .map((row) => JSON.parse(row.json).body.text as string)
    .filter((text) => text.startsWith(PREFIX)).map((text) => JSON.parse(text.slice(PREFIX.length)))
    .find((change) => change.epoch === 1);
  expect(resetPut?.rev).toBe(0);
  console.log("N2 authority view AFTER reset: last_run=S0+" + (afterA.last_run! - S0) / MIN + "m next_run=S0+" + (afterA.next_run! - S0) / MIN + "m last_result=" + JSON.stringify(afterA.last_result));

  // The reset's own next slot (S0+15m) and whatever next_run the authority now shows.
  wallA.value = S0 + 15 * MIN;
  const r1 = lead.claimFromPeer(H.nodeId, { schedule: ID, slot: S0 + 15 * MIN, run: "44444444-4444-4444-8444-444444444444", epoch });
  console.log("N2 claim reset slot S0+15m:", JSON.stringify(r1));
  // Hina receives the reset; what does the holder see?
  feed(H, A.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 50 }).map((r) => JSON.parse(r.json)));
  const afterH = readSchedules(H).find((s) => s.id === ID)!;
  expect(afterH).toEqual(afterA);
  expect(() => new Schedules(H, { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} })
    .edit(ID, { name: "After reset" })).toThrow("only the schedule authority writes changes");
  new Schedules(A, { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} })
    .edit(ID, { name: "After reset" });
  const laterPut = A.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 50 })
    .map((row) => JSON.parse(row.json).body.text as string)
    .filter((text) => text.startsWith(PREFIX)).map((text) => JSON.parse(text.slice(PREFIX.length)))
    .find((change) => change.schedule?.name === "After reset");
  expect(laterPut).toMatchObject({ epoch: 1, rev: 1 });
  feed(H, A.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 50 }).map((r) => JSON.parse(r.json)));
  expect(readSchedules(A)[0]?.name).toBe("After reset");
  expect(readSchedules(H)[0]?.name).toBe("After reset");
  console.log("N2 holder view AFTER reset: last_run=S0+" + (afterH.last_run! - S0) / MIN + "m next_run=S0+" + (afterH.next_run! - S0) / MIN + "m");
  for (const t of [S0 + HOUR, S0 + 2 * HOUR + 5 * MIN]) {
    wallA.value = t;
    const r = lead.claimFromPeer(H.nodeId, { schedule: ID, slot: afterH.next_run!, run: "55555555-5555-4555-8555-555555555555", epoch });
    console.log(`N2 at S0+${(t - S0) / MIN}m claim holder next_run:`, JSON.stringify(r));
  }
  expect(r1).toMatchObject({ claimed: true }); // the reset's purpose
});
