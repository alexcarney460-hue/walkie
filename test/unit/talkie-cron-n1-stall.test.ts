import { expect, test } from "bun:test";
import { readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { DUE, HOUR, ID, MIN, RUN, claimPosts, fixture, reset, ticker, type Row } from "./talkie-cron-fixture.ts";

async function drive(label: string, f: ReturnType<typeof fixture>, wall: { value: number }, times: number[]) {
  const { schedules, decisions } = ticker(f.core, f.lead, f.epoch);
  for (const t of times) {
    wall.value = t;
    await schedules.tick(t).catch(() => {});
    const s = readSchedules(f.core).find((x) => x.id === ID)!;
    const d = decisions.at(-1);
    console.log(`${label} t=DUE${t >= DUE ? "+" : ""}${(t - DUE) / MIN}m next_run=DUE+${(s.next_run! - DUE) / MIN}m`
      + ` claim(slot=DUE+${d ? (d.slot - DUE) / MIN : "?"}m)=${JSON.stringify(d?.result)} last_result=${JSON.stringify(s.last_result)}`);
  }
  return decisions;
}

// N1a: the builder's own P4 fix scenario (claim at DUE, authority clock steps back 3 min, person resets).
test("N1a P4 scenario: after reset the schedule never claims again (next_run stuck at the floor)", async () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const f = fixture(rows, wall);
  expect(f.lead.claimFromPeer("a".repeat(16), { schedule: ID, slot: DUE, run: RUN, epoch: f.epoch }).claimed).toBe(true);
  wall.value = DUE - 3 * MIN;
  const updated = reset(f.core, wall.value);
  console.log("N1a reset: next_run=DUE+" + (updated.next_run! - DUE) / MIN + "m floor=DUE+" + (claimPosts(rows).at(-1)!.refusal_floor - DUE) / MIN + "m");
  const decisions = await drive("N1a", f, wall, [DUE, DUE + 5 * MIN, DUE + 10 * MIN, DUE + 2 * HOUR, DUE + 24 * HOUR, DUE + 7 * 24 * HOUR]);
  expect(decisions.some((d) => (d.result as { claimed: boolean }).claimed)).toBe(true); // liveness expectation
});

// N1b: in-window bogus last_run (50 min ahead, */5 => maxAdvance 60 min) reaches the floor.
test("N1b bogus last_run 50 min ahead: floor = now+50m, next_run = now+5m, stall outlives the floor", async () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const f = fixture(rows, wall, { last_run: DUE + 50 * MIN, next_run: DUE + 55 * MIN });
  const updated = reset(f.core, DUE);
  console.log("N1b reset: next_run=DUE+" + (updated.next_run! - DUE) / MIN + "m floor=DUE+" + (claimPosts(rows).at(-1)!.refusal_floor - DUE) / MIN + "m");
  const decisions = await drive("N1b", f, wall, [DUE + 5 * MIN, DUE + 55 * MIN, DUE + 2 * HOUR, DUE + 24 * HOUR]);
  expect(decisions.some((d) => (d.result as { claimed: boolean }).claimed)).toBe(true);
});

// N1c: daily schedule (data-room-refresh default cron) with a last_run 20 h ahead: maxAdvance = 24 h keeps it.
test("N1c daily cron, last_run 20h ahead: floor keeps it (maxAdvance=24h) and the schedule stalls", async () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const f = fixture(rows, wall, { cron: "0 9 * * *", last_run: DUE + 20 * HOUR, next_run: null });
  const updated = reset(f.core, DUE);
  console.log("N1c reset: next_run=DUE+" + (updated.next_run! - DUE) / MIN + "m floor=DUE+" + (claimPosts(rows).at(-1)!.refusal_floor - DUE) / MIN + "m");
  const decisions = await drive("N1c", f, wall, [updated.next_run!, DUE + 30 * HOUR, DUE + 3 * 24 * HOUR]);
  expect(decisions.some((d) => (d.result as { claimed: boolean }).claimed)).toBe(true);
});

// Control: a reset with no future inputs lets the next slot run.
test("CONTROL clean reset: next slot is claimed", async () => {
  const rows: Row[] = [];
  const wall = { value: DUE + MIN };
  const f = fixture(rows, wall);
  const updated = reset(f.core, wall.value);
  console.log("CONTROL reset: next_run=DUE+" + (updated.next_run! - DUE) / MIN + "m");
  const decisions = await drive("CONTROL", f, wall, [DUE + 5 * MIN]);
  expect(decisions.some((d) => (d.result as { claimed: boolean }).claimed)).toBe(true);
});
