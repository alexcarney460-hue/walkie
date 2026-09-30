import { expect, test } from "bun:test";
import { loadScheduleClaims, saveScheduleClaims } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { A, B, CLAIM_PREFIX, DUE, ID, MIN, PREFIX, fixture, uuid, type Row } from "./talkie-cron-round12-fixture.ts";

function predecessorRows(): Row[] {
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: "alex", last_run: null, next_run: DUE, last_result: null, failures: 0, run_id: null };
  const body = (text: string) => JSON.stringify({ body: { text } });
  return [
    { id: `${A}:1`, origin: A, seq: 1, ts: DUE - MIN,
      json: body(PREFIX + JSON.stringify({ op: "put", term: 0, rev: 0, schedule })) },
    { id: `${A}:2`, origin: A, seq: 2, ts: DUE,
      json: body(CLAIM_PREFIX + JSON.stringify({ schedule: ID, slot: DUE, run: uuid(1), epoch: 1,
        holder: A, term: 0, after: null, at: DUE, checks: {} })) },
  ];
}

function successor() {
  return fixture(B, 1, predecessorRows(), [
    { authority: A, after: null, floor: 0, ceiling: 3 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], { value: DUE + 20_000 }, { [A]: 2, [B]: 0 }, { [A]: 2 });
}

test("A4b a missing local claim record is re-seeded before a duplicate run", () => {
  const b = successor();
  const claim = (run: string) => b.lead.claimFromPeer(B, { schedule: ID, slot: DUE, run, epoch: b.epoch });
  expect(claim(uuid(2))).toEqual({ claimed: false, reason: "just_ran" });
  expect(loadScheduleClaims(b.core, 1)).toHaveLength(1);
  saveScheduleClaims(b.core, 1, []); // simulate retention eviction before this id is checked again
  expect(claim(uuid(3))).toEqual({ claimed: false, reason: "just_ran" });
  expect(loadScheduleClaims(b.core, 1)).toHaveLength(1);
});

test("A4b a retained claim is not re-seeded on every request", () => {
  const b = successor();
  const store = b.core.store as unknown as { scheduleClaimEvents: (...args: unknown[]) => unknown };
  const original = store.scheduleClaimEvents.bind(store);
  let reads = 0;
  store.scheduleClaimEvents = (...args) => { reads++; return original(...args); };
  for (let n = 2; n < 5; n++) expect(b.lead.claimFromPeer(B, {
    schedule: ID, slot: DUE, run: uuid(n), epoch: b.epoch }).reason).toBe("just_ran");
  expect(reads).toBe(1);
});

test("B1d a restarted authority reconstructs the predecessor claim from signed posts", () => {
  const rows = predecessorRows();
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }],
    { value: DUE + 20_000 }, { [A]: 2 }, null);
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: uuid(5), epoch: current.epoch }))
    .toEqual({ claimed: false, reason: "just_ran" });
  const restarted = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }],
    { value: DUE + 20_000 }, { [A]: 2 }, null);
  expect(restarted.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: uuid(6), epoch: restarted.epoch }))
    .toEqual({ claimed: false, reason: "just_ran" });
});
