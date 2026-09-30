// N7 (real Core, single machine = authority + holder): slots run with a correct clock, then the clock steps back
// 2 h. The claim reports clock_error and noteScheduleClockError signs a `note` whose ts (clock + 5 min) is below
// every earlier event of this origin. With the new per-origin seq dedup in foldSchedules, does the schedule survive?
import { afterEach, expect, test } from "bun:test";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL, nextRuns } from "../../src/protocol/talkie-schedule.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const PREFIX = "walkie-talkie-schedule:v1:";
const MIN = 60_000, HOUR = 60 * MIN;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

test("N7 clock_error note after a 2 h step-back erases the schedule from the fold", () => {
  const a = tnode("alex");
  const { team, create } = createTeam(a);
  const S0 = Math.floor(now() / 300_000) * 300_000 + 600_000;
  const wall = { value: S0 - MIN };
  const A = makeCore(a, team, cleanups, { clock: () => wall.value });
  A.ingest(create, "local");
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL });
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: a.handle, last_run: null, next_run: S0, last_result: null, failures: 0, run_id: null };
  A.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) }, { channel: SCHEDULE_CHANNEL });
  let mono = 0;
  const lead = new Leadership({ core: A, preferred: () => A.nodeId, lost: () => {}, now: () => wall.value, monoNow: () => mono });
  mono = 34_000;
  const epoch = lead.grant(A.nodeId).epoch;
  for (let slot = S0, n = 1; slot <= S0 + HOUR; slot += 5 * MIN, n++) {
    wall.value = slot;
    const s = readSchedules(A).find((x) => x.id === ID)!;
    expect(lead.claimFromPeer(A.nodeId, { schedule: ID, slot, run: uuid(n), epoch }).claimed).toBe(true);
    A.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule: {
      ...s, run_id: uuid(n), last_run: slot, next_run: nextRuns(s.cron, slot, 1)[0]! } }) }, { channel: SCHEDULE_CHANNEL });
  }
  console.log("N7 before step-back: schedules =", readSchedules(A).map((s) => s.name).join(","));
  wall.value = S0 + HOUR + MIN - 2 * HOUR; // clock steps back 2 h
  const s1 = readSchedules(A).find((x) => x.id === ID)!;
  const r = lead.claimFromPeer(A.nodeId, { schedule: ID, slot: s1.next_run!, run: uuid(90), epoch });
  console.log("N7 claim after step-back:", JSON.stringify(r));
  const after = readSchedules(A);
  console.log("N7 schedules after the clock_error note:", JSON.stringify(after.map((s) => s.name)));
  let resetErr: unknown = null;
  try { new Schedules(A, { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} }).reset(ID, wall.value); }
  catch (e) { resetErr = e; }
  console.log("N7 person runs reset:", resetErr ? `${(resetErr as { status?: number }).status} ${String(resetErr)}` : "ok");
  wall.value = S0 + 3 * HOUR; // clock corrected (forward)
  console.log("N7 schedules after clock correction:", JSON.stringify(readSchedules(A).map((s) => s.name)));
  expect(after.map((s) => s.id)).toContain(ID);
});
