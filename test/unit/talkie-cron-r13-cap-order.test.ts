// Round 13 item 1 follow-up: the schedule cap keeps the OLDEST schedules by creation, the same way in the full fold and in
// the cached read every replica uses. Editing the oldest schedule after the cache was built must not push it out.
import { expect, test } from "bun:test";
import { MAX_SCHEDULES } from "../../src/protocol/talkie-schedule.ts";
import { foldSchedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { A, DUE, MIN, PREFIX, fixture, type Row } from "./talkie-cron-round12-fixture.ts";

const uuid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sched = (n: number, extra: Record<string, unknown> = {}) => ({ id: uuid(n), name: `S${String(100 - n)}`, cron: "*/5 * * * *",
  task: { prompt: `task ${n}` }, enabled: true, created_by: "alex", last_run: null, next_run: DUE, last_result: null, failures: 0, run_id: null, ...extra });
const post = (rows: Row[], seq: number, ts: number, change: unknown) => rows.push({ id: `${A}:${String(seq).padStart(6, "0")}`, origin: A, seq, ts,
  json: JSON.stringify({ body: { text: PREFIX + JSON.stringify(change) } }) });

test("R13-1x the cached read and the full fold keep the same oldest schedules when more than the cap exist", () => {
  const rows: Row[] = [];
  const total = MAX_SCHEDULES + 5;
  for (let n = 1; n <= total; n++) post(rows, n, DUE - 60 * MIN + n * 1_000, { op: "put", term: 0, rev: 1, schedule: sched(n) });
  const wall = { value: DUE };
  const vv = { [A]: total };
  const f = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, vv, null);
  const first = readSchedules(f.core).map((s) => s.id).sort();
  expect(first).toEqual(Array.from({ length: MAX_SCHEDULES }, (_v, n) => uuid(n + 1)).sort());
  // After the cache exists: the oldest schedule is edited (rev 2), then one of the kept ones is removed.
  f.core.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, rev: 2, schedule: sched(1, { name: "Edited oldest" }) }) }, { channel: "talkie-schedules" });
  wall.value = DUE + MIN;
  f.core.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "remove", term: 0, rev: 2, id: uuid(2) }) }, { channel: "talkie-schedules" });
  const folded = () => foldSchedules(rows.map((r) => ({ body: { text: JSON.parse(r.json).body.text as string }, author: { handle: "alex" },
    origin: r.origin, seq: r.seq, ts: r.ts })), f.core.authorityClaimTerms).map((s) => s.id).sort();
  const full = folded();
  const cached = readSchedules(f.core).map((s) => s.id).sort();
  expect(cached).toEqual(full);
  expect(cached).toHaveLength(MAX_SCHEDULES);
  expect(cached).toContain(uuid(1));
  expect(cached).not.toContain(uuid(2));
  expect(cached).toContain(uuid(MAX_SCHEDULES + 1)); // cap applies to surviving ids after the sequence fold
  expect(cached).not.toContain(uuid(MAX_SCHEDULES + 2));
  // A late-arriving change that sorts before the current head refolds that one schedule; it keeps its place by creation.
  wall.value = DUE + 2 * MIN;
  f.core.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule: sched(1, { name: "Late arrival" }) }) }, { channel: "talkie-schedules" });
  const refolded = readSchedules(f.core);
  expect(refolded.map((s) => s.id).sort()).toEqual(folded());
  expect(refolded.map((s) => s.id)).toContain(uuid(1));
  expect(refolded.find((s) => s.id === uuid(1))?.name).toBe("Edited oldest");
});
