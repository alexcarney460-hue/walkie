// N6: the authority clock is CORRECT while slots run, then steps BACK 2 h (dead RTC, VM restore). Claims correctly
// report clock_error (safe). The person follows the alert and resets. Do slots that really ran before the reset
// (their labels are below the real reset time) run again?
import { expect, test } from "bun:test";
import { readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { nextRuns } from "../../src/protocol/talkie-schedule.ts";
import { A, DUE, HOUR, ID, MIN, claimPosts, fixture, reset, type Row } from "./talkie-cron-fixture.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("N6c 3h step-back (no pre-reset clock_error note, isolates the floor) reset while the authority clock is behind reopens slots that already ran", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const f = fixture(rows, wall);
  const ran: number[] = [];
  // Correct clock: slots DUE .. DUE+60m run normally (claim + holder put, as launch() does).
  for (let slot = DUE, n = 1; slot <= DUE + HOUR; slot += 5 * MIN, n++) {
    wall.value = slot;
    const s = readSchedules(f.core).find((x) => x.id === ID)!;
    const r = f.lead.claimFromPeer(A, { schedule: ID, slot, run: uuid(n), epoch: f.epoch });
    if (!r.claimed) throw new Error(`setup claim ${slot} refused ${JSON.stringify(r)}`);
    ran.push(slot);
    f.core.emit("msg.post", { text: "walkie-talkie-schedule:v1:" + JSON.stringify({ op: "put", term: 0, schedule: {
      ...s, run_id: uuid(n), last_run: slot, next_run: nextRuns(s.cron, slot, 1)[0]! } }) }, { channel: "talkie-schedules" });
  }
  // Authority clock steps back 2 h.
  wall.value = DUE + HOUR + 1 * MIN - 3 * HOUR;
  const count = rows.length;
  expect(() => reset(f.core, wall.value)).toThrow("this machine's clock is behind recent schedule activity; newest claim time");
  expect(rows).toHaveLength(count);
  expect(claimPosts(rows).filter((claim) => claim.reset)).toHaveLength(0);
  expect(readSchedules(f.core)[0]?.last_run).toBe(DUE + HOUR);
});
