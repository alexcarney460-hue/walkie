// Round 13 item 6: a clock refusal names the value that actually tripped the guard (a claim, a reset record, the last run
// mark, or this machine's own schedule change), and never says "no signed claim time is available" when a value did.
import { expect, test } from "bun:test";
import { A, DUE, HOUR, ID, MIN, PREFIX, fixture, reset, uuid, type Row } from "./talkie-cron-round12-fixture.ts";

const TERMS = [{ authority: A, after: null, floor: 0, ceiling: null }];
const iso = (ms: number) => new Date(ms).toISOString();
const sched = (extra: Record<string, unknown> = {}) => ({ id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" },
  enabled: true, created_by: "alex", last_run: null, next_run: DUE, last_result: null, failures: 0, run_id: null, ...extra });
const putRow = (ts: number, extra: Record<string, unknown> = {}): Row => ({ id: `${A}:000001`, origin: A, seq: 1, ts,
  json: JSON.stringify({ body: { text: PREFIX + JSON.stringify({ op: "put", term: 0, rev: 1, schedule: sched(extra) }) } }) });
const alerts = (rows: Row[]) => rows.map((row) => JSON.parse(row.json) as { channel?: string; body: { text: string } })
  .filter((row) => row.channel === "general").map((row) => row.body.text);

function refusal(fn: () => unknown): string {
  try { fn(); } catch (err) { return String(err); }
  throw new Error("expected a refusal");
}

test("R13-6a reset refused on this machine's own schedule change time names that time, not a missing claim", () => {
  const wall = { value: DUE };
  const ahead = DUE + 5 * HOUR;
  const rows: Row[] = [putRow(ahead)];
  const f = fixture(A, 0, rows, TERMS, wall, { [A]: 1 }, null);
  const message = refusal(() => reset(f.core, wall.value));
  expect(message).toContain("this machine's clock is behind recent schedule activity");
  expect(message).toContain(`this machine's own schedule change time ${iso(ahead)}`);
  expect(message).toContain("300 minutes ahead of this machine's clock");
  expect(message).not.toContain("no signed claim time is available");
});

test("R13-6b reset refused on a reset record's time names the reset record", () => {
  const rows: Row[] = [];
  const wall = { value: DUE + 3 * HOUR };
  const f = fixture(A, 0, rows, TERMS, wall, { [A]: 1 }, null);
  reset(f.core, wall.value);
  wall.value = DUE + 10 * MIN;
  const message = refusal(() => reset(f.core, wall.value));
  expect(message).toContain(`reset record time ${iso(DUE + 3 * HOUR)}`);
  expect(message).toContain(A);
  expect(message).not.toContain("no signed claim time is available");
});

test("R13-6c a claim refused on a reset refusal floor names the floor in the alert", () => {
  const rows: Row[] = [];
  const wall = { value: DUE + 3 * HOUR };
  const f = fixture(A, 0, rows, TERMS, wall, { [A]: 1 }, null);
  reset(f.core, wall.value);
  wall.value = DUE + 10 * MIN;
  const answer = f.lead.claimFromPeer(A, { schedule: ID, slot: DUE + 3 * HOUR + 5 * MIN, run: uuid(1), epoch: f.epoch });
  expect(answer).toMatchObject({ claimed: false, reason: "clock_error" });
  const alert = alerts(rows).at(-1)!;
  expect(alert).toContain(`reset refusal floor ${iso(DUE + 3 * HOUR)}`);
  expect(alert).toContain("170 minutes ahead");
  expect(alert).not.toContain("no signed claim time is available");
});

test("R13-6d a claim refused on the schedule's last run mark names the last run time in the alert", () => {
  const wall = { value: DUE };
  const lastRun = DUE + 5 * HOUR;
  const rows: Row[] = [putRow(DUE - 5 * MIN, { last_run: lastRun, next_run: lastRun + 5 * MIN })];
  const f = fixture(A, 0, rows, TERMS, wall, { [A]: 1 }, null);
  const answer = f.lead.claimFromPeer(A, { schedule: ID, slot: lastRun + 5 * MIN, run: uuid(2), epoch: f.epoch });
  expect(answer).toMatchObject({ claimed: false, reason: "clock_error" });
  const alert = alerts(rows).at(-1)!;
  expect(alert).toContain(`last run time ${iso(lastRun)}`);
  expect(alert).toContain("300 minutes ahead");
  expect(alert).not.toContain("no signed claim time is available");
});

test("R13-6e a claim refused on an earlier claim's slot names the claimed slot and the signing machine", () => {
  const rows: Row[] = [];
  const wall = { value: DUE + 3 * HOUR };
  const f = fixture(A, 0, rows, TERMS, wall, { [A]: 1 }, null);
  expect(f.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: uuid(3), epoch: f.epoch }).claimed).toBe(true);
  f.core.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, rev: 2,
    schedule: sched({ last_run: DUE, next_run: DUE + 3 * HOUR + 5 * MIN }) }) }, { channel: "talkie-schedules" });
  const fastSlot = DUE + 3 * HOUR + 5 * MIN;
  wall.value = fastSlot;
  expect(f.lead.claimFromPeer(A, { schedule: ID, slot: fastSlot, run: uuid(4), epoch: f.epoch }).claimed).toBe(true);
  wall.value = DUE + 10 * MIN;
  expect(f.lead.claimFromPeer(A, { schedule: ID, slot: fastSlot, run: uuid(5), epoch: f.epoch }))
    .toMatchObject({ claimed: false, reason: "clock_error" });
  const alert = alerts(rows).at(-1)!;
  expect(alert).toContain(`claimed slot ${iso(fastSlot)}`);
  expect(alert).toContain(A);
  expect(alert).toContain("175 minutes ahead");
  expect(alert).toContain("Removing and re-adding it with a new id resumes it now");
});
