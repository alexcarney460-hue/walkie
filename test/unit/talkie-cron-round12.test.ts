import { expect, test } from "bun:test";
import { foldSchedules, readSchedules, Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { CLAIM_PREFIX } from "../../src/daemon/orchestrator/schedule-claims.ts";
import type { Core } from "../../src/daemon/core.ts";

const id = "11111111-1111-4111-8111-111111111111";
const prefix = "walkie-talkie-schedule:v1:";
const base = { id, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
  created_by: "alex", last_run: null, next_run: 300_000, last_result: null, failures: 0, run_id: null };
const post = (change: Record<string, unknown>, seq: number, origin = "authority") => ({ origin, seq, ts: seq,
  body: { text: prefix + JSON.stringify({ term: 0, ...change }) } });

test("a non-authority maximum epoch and revision cannot win the fold", () => {
  const events = [post({ op: "put", schedule: base }, 1),
    post({ op: "put", epoch: Number.MAX_SAFE_INTEGER, rev: Number.MAX_SAFE_INTEGER,
      schedule: { ...base, name: "forged" } }, 2, "attacker"),
    post({ op: "put", rev: 2, schedule: { ...base, name: "edited" } }, 3)];
  expect(foldSchedules(events, [{ authority: "authority", after: null, floor: 0, ceiling: null }])[0]?.name).toBe("edited");
});

test("a legitimate edit and authority reset advance the fold", () => {
  const events = [post({ op: "put", schedule: base }, 1), post({ op: "put", rev: 1,
    schedule: { ...base, name: "edited" } }, 2),
    { origin: "authority", seq: 3, ts: 3, body: { text: CLAIM_PREFIX + JSON.stringify({
      schedule: id, slot: 0, run: "22222222-2222-4222-8222-222222222222", epoch: 0,
      holder: "authority", term: 0, after: null, at: 3, checks: {}, reset: true, refusal_floor: 3 }) } },
    post({ op: "put", epoch: 1, rev: 0, schedule: { ...base, name: "reset" } }, 4)];
  expect(foldSchedules(events, [{ authority: "authority", after: null, floor: 0, ceiling: null }])[0]?.name).toBe("reset");
});

import { A, B, DUE, ID, MIN, fixture as claimFixture, reset as resetClaims, uuid, type Row } from "./talkie-cron-round12-fixture.ts";
import { nextRuns } from "../../src/protocol/talkie-schedule.ts";

test("a removed id cannot be re-added even with a later authority post", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const f = claimFixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  const original = readSchedules(f.core)[0]!;
  expect(f.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: uuid(1), epoch: f.epoch }).claimed).toBe(true);
  f.core.emit("msg.post", { text: prefix + JSON.stringify({ op: "put", term: 0, epoch: 0, rev: 1,
    schedule: { ...original, last_run: DUE, next_run: nextRuns(original.cron, DUE, 1)[0]! } }) }, { channel: "talkie-schedules" });
  f.core.emit("msg.post", { text: prefix + JSON.stringify({ op: "remove", term: 0, id: ID, epoch: 0, rev: 2 }) }, { channel: "talkie-schedules" });
  expect(readSchedules(f.core)).toEqual([]);
  f.lead.grant(A);
  f.core.emit("msg.post", { text: prefix + JSON.stringify({ op: "put", term: 0, epoch: 0, rev: 3,
    schedule: { ...original, next_run: DUE } }) }, { channel: "talkie-schedules" });
  wall.value = DUE + MIN;
  expect(readSchedules(f.core)).toEqual([]);
  expect(f.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: uuid(2), epoch: f.epoch }).claimed).toBe(false);
});


test("reset writes nothing until the predecessor authority stream is covered", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const vv = { [A]: 1, [B]: 1 };
  const f = claimFixture(B, 1, rows, [
    { authority: A, after: null, floor: 0, ceiling: 10 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], wall, vv, { [A]: 10 });
  const before = rows.length;
  expect(() => resetClaims(f.core, DUE)).toThrow();
  expect(rows).toHaveLength(before);
  vv[A] = 10;
  expect(resetClaims(f.core, DUE).id).toBe(ID);
  expect(rows.length).toBeGreaterThan(before);
});

test("clock refusal names the claim and a new schedule id does not inherit it", () => {
  const rows: Row[] = [];
  const wall = { value: DUE + 3 * 60 * MIN };
  const f = claimFixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  const sa = new Schedules(f.core, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} });
  expect(f.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: uuid(3), epoch: f.epoch }).claimed).toBe(true);
  wall.value = DUE + 10 * MIN;
  try { sa.reset(ID, wall.value); throw new Error("reset unexpectedly succeeded"); }
  catch (err) {
    expect(err).toMatchObject({ status: 409, code: "clock_behind" });
    expect(String(err)).toContain("newest claim time");
    expect(String(err)).toContain(A);
    expect(String(err)).toContain("Removing and re-adding it with a new id resumes it now");
  }
  const old = sa.get(ID);
  sa.remove(ID);
  const added = sa.add({ name: old.name, cron: old.cron, task: old.task }, "alex");
  expect(added.id).not.toBe(ID);
  const slot = DUE + 15 * MIN;
  f.core.emit("msg.post", { text: prefix + JSON.stringify({ op: "put", term: 0, rev: 1,
    schedule: { ...added, next_run: slot } }) }, { channel: "talkie-schedules" });
  wall.value = slot;
  expect(f.lead.claimFromPeer(A, { schedule: added.id, slot, run: uuid(4), epoch: f.epoch }).claimed).toBe(true);
});

test("clock-error alert identifies the signed claim machine, time and offset", () => {
  const rows: Row[] = [];
  const wall = { value: DUE + 3 * 60 * MIN };
  const f = claimFixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  const original = readSchedules(f.core)[0]!;
  expect(f.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: uuid(5), epoch: f.epoch }).claimed).toBe(true);
  const fastSlot = wall.value + 5 * MIN;
  f.core.emit("msg.post", { text: prefix + JSON.stringify({ op: "put", term: 0, rev: 1,
    schedule: { ...original, last_run: DUE, next_run: fastSlot } }) }, { channel: "talkie-schedules" });
  wall.value = fastSlot;
  expect(f.lead.claimFromPeer(A, { schedule: ID, slot: fastSlot, run: uuid(6), epoch: f.epoch }).claimed).toBe(true);
  wall.value = DUE + 10 * MIN;
  const answer = f.lead.claimFromPeer(A, { schedule: ID, slot: fastSlot, run: uuid(7), epoch: f.epoch });
  expect(answer).toMatchObject({ claimed: false, reason: "clock_error" });
  const alerts = rows.map((row) => JSON.parse(row.json) as { channel?: string; body: { text: string } })
    .filter((row) => row.channel === "general").map((row) => row.body.text);
  expect(alerts.at(-1)).toContain("claimed slot");
  expect(alerts.at(-1)).toContain(A);
  expect(alerts.at(-1)).toContain("175 minutes ahead");
  expect(alerts.at(-1)).toContain("Removing and re-adding it with a new id resumes it now");
});

test("a successor seeds claims for an id removed at handover", () => {
  const aRows: Row[] = [];
  const wallA = { value: DUE };
  const a = claimFixture(A, 0, aRows, [{ authority: A, after: null, floor: 0, ceiling: null }], wallA, { [A]: 1 }, null);
  const original = readSchedules(a.core)[0]!;
  expect(a.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: uuid(8), epoch: a.epoch }).claimed).toBe(true);
  a.core.emit("msg.post", { text: prefix + JSON.stringify({ op: "remove", term: 0, id: ID, rev: 1 }) }, { channel: "talkie-schedules" });
  const rows = [...aRows];
  const wallB = { value: DUE + MIN };
  const b = claimFixture(B, 1, rows, [
    { authority: A, after: null, floor: 0, ceiling: null },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], wallB, { [A]: aRows.at(-1)!.seq, [B]: 1 }, { [A]: aRows.at(-1)!.seq });
  expect(readSchedules(b.core)).toEqual([]);
  b.core.emit("msg.post", { text: prefix + JSON.stringify({ op: "put", term: 1, after: "transfer:1", rev: 2,
    schedule: original }) }, { channel: "talkie-schedules" });
  expect(readSchedules(b.core)).toEqual([]);
  expect(b.lead.claimFromPeer(B, { schedule: ID, slot: DUE, run: uuid(9), epoch: b.epoch }).claimed).toBe(false);
});
