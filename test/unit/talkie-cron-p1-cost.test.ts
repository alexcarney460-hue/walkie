// P1 (round 11): cost of readSchedules after 113fc66. The incremental path now refolds (JSON.parse + zod + sort) the
// whole retained event list on every count change; before, it folded only the cached state plus the new rows.
// Schedule puts and claim posts are never pruned, so N grows with every run.
import { expect, test } from "bun:test";
import { readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import type { Core } from "../../src/daemon/core.ts";

const PREFIX = "walkie-talkie-schedule:v1:";
const CLAIM = "walkie-talkie-claim:v1:";
const ID = "11111111-1111-4111-8111-111111111111";
type Row = { id: string; origin: string; seq: number; ts: number; json: string };

function rowsFor(n: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const text = i % 3 === 2
      ? CLAIM + JSON.stringify({ schedule: ID, slot: i, run: "22222222-2222-4222-8222-222222222222", epoch: 1, holder: "a", term: 0, after: null, at: i, checks: {} })
      : PREFIX + JSON.stringify({ op: "put", epoch: 0, rev: i - Math.floor((i + 1) / 3), schedule: { id: ID, name: "Check", cron: "*/5 * * * *",
          task: { prompt: "Check the board and post a summary" }, enabled: true, created_by: "alex", last_run: i, next_run: i + 300_000,
          last_result: "ok ".repeat(40), failures: 0, run_id: "33333333-3333-4333-8333-333333333333" } });
    out.push({ id: `o:${String(i).padStart(9, "0")}`, origin: "o", seq: i + 1, ts: 1_000_000 + i, json: JSON.stringify({ body: { text } }) });
  }
  return out;
}

test("P1 per-write readSchedules cost vs retained schedule-channel posts", () => {
  let maxAt50k = 0;
  for (const n of [10_000, 50_000]) {
    const rows = rowsFor(n);
    const desc = [...rows].reverse();
    const core = { store: { channelEventCount: () => rows.length,
      queryEvents: (f: { since_ts?: number }) => f.since_ts === undefined ? desc : desc.filter((r) => r.ts > f.since_ts!) } } as unknown as Core;
    let t = performance.now();
    readSchedules(core);
    const full = performance.now() - t;
    const times: number[] = [];
    for (let k = 0; k < 3; k++) {
      const extra = rowsFor(1)[0]!;
      const change = JSON.parse(JSON.parse(extra.json).body.text.slice(PREFIX.length));
      change.rev = n - Math.floor(n / 3) + k;
      const r = { ...extra, json: JSON.stringify({ body: { text: PREFIX + JSON.stringify(change) } }), id: `p:${n}:${k}`, ts: 2_000_000_000 + k, seq: n + k + 1 };
      rows.push(r); desc.unshift(r);
      t = performance.now();
      readSchedules(core);
      times.push(performance.now() - t);
    }
    if (n === 50_000) maxAt50k = Math.max(...times);
    console.log(`P1 N=${n}: first full read ${full.toFixed(0)} ms; incremental reads after one new post: ${times.map((x) => x.toFixed(0)).join(", ")} ms`);
  }
  expect(maxAt50k).toBeLessThan(20);
}, 60_000);
