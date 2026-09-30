// N7b (real Core, single machine): schedule created a day earlier; a person edits its prompt; runs continue; the clock
// steps back 2 h; the clock_error note is signed. Does the fold revert the person's edit?
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

test("N7b a clock_error note reverts a person's earlier prompt edit", () => {
  const a = tnode("alex");
  const { team, create } = createTeam(a);
  const S0 = Math.floor(now() / 300_000) * 300_000 + 24 * HOUR;
  const wall = { value: now() + 1000 };
  const A = makeCore(a, team, cleanups, { clock: () => wall.value });
  A.ingest(create, "local");
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL });
  const sched = new Schedules(A, { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} });
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "OLD PROMPT: delete stale branches" }, enabled: true,
    created_by: a.handle, last_run: null, next_run: S0, last_result: null, failures: 0, run_id: null };
  A.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) }, { channel: SCHEDULE_CHANNEL }); // a day earlier
  let mono = 0;
  const lead = new Leadership({ core: A, preferred: () => A.nodeId, lost: () => {}, now: () => wall.value, monoNow: () => mono });
  mono = 34_000;
  const epoch = lead.grant(A.nodeId).epoch;
  wall.value = S0 - 30 * MIN;
  const edited = readSchedules(A).find((x) => x.id === ID)!;
  A.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule: { ...edited, task: { prompt: "NEW PROMPT: report only, never delete" } } }) }, { channel: SCHEDULE_CHANNEL });
  for (let slot = S0, n = 1; slot <= S0 + HOUR; slot += 5 * MIN, n++) {
    wall.value = slot;
    const s = readSchedules(A).find((x) => x.id === ID)!;
    expect(lead.claimFromPeer(A.nodeId, { schedule: ID, slot, run: uuid(n), epoch }).claimed).toBe(true);
    A.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule: {
      ...s, run_id: uuid(n), last_run: slot, next_run: nextRuns(s.cron, slot, 1)[0]! } }) }, { channel: SCHEDULE_CHANNEL });
  }
  const before = readSchedules(A).find((x) => x.id === ID)!;
  console.log("N7b before step-back: prompt =", JSON.stringify(before.task), "last_run=S0+" + (before.last_run! - S0) / MIN + "m");
  wall.value = S0 + HOUR + MIN - 2 * HOUR;
  const r = lead.claimFromPeer(A.nodeId, { schedule: ID, slot: before.next_run!, run: uuid(90), epoch });
  const after = readSchedules(A).find((x) => x.id === ID)!;
  console.log("N7b claim:", JSON.stringify(r), "| after note: prompt =", JSON.stringify(after.task), "last_run =", after.last_run, "next_run=S0" + (after.next_run! - S0) / MIN + "m");
  wall.value = S0 + 3 * HOUR;
  const later = readSchedules(A).find((x) => x.id === ID)!;
  console.log("N7b after clock correction: prompt =", JSON.stringify(later.task));
  expect(after.task).toEqual({ prompt: "NEW PROMPT: report only, never delete" });
  expect(after.last_run).toBe(S0 + HOUR);
});
