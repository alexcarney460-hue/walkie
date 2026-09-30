import { expect, test } from "bun:test";
import { DUE, HOUR, ID, RUN, claimPosts, fixture, reset, type Row } from "./talkie-cron-fixture.ts";

test("sparse cron caps the clock-error and reset bounds at 48 hours", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const f = fixture(rows, wall, { cron: "0 0 1 * *", last_run: DUE + 72 * HOUR });
  expect(f.lead.claimFromPeer(f.core.nodeId, { schedule: ID, slot: DUE, run: RUN, epoch: f.epoch }))
    .toEqual({ claimed: false, reason: "clock_error" });
  reset(f.core, DUE);
  expect(claimPosts(rows).at(-1)?.refusal_floor).toBe(DUE);
});
