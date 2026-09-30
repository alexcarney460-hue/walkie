// Round 13 item 3: retaining every removed id's newest claim can exceed the 1,000-record StoredClaims cap, after which
// saveScheduleClaims throws and every claim stops. A removed id's newest claim is kept only for the 48 h window after
// its removal, the cap is never exceeded, and eviction takes the oldest removals first and never a live record.
import { expect, test } from "bun:test";
import { CLAIMS_PER_SCHEDULE, compactClaims, loadScheduleClaims, type StoredClaim } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { A, B, CLAIM_PREFIX, HOUR, ID, MIN, PREFIX, fixture, type Row, type Term, uuid } from "./talkie-cron-round12-fixture.ts";

const CAP = 20 * CLAIMS_PER_SCHEDULE;
// Far enough from the epoch that "48 h ago" is still a valid non-negative timestamp.
const DUE = 30 * 24 * HOUR;
const NOW = DUE + 20_000;
const sched = (id: string, name: string) => ({ id, name, cron: "*/5 * * * *", task: { prompt: name }, enabled: true,
  created_by: "alex", last_run: null, next_run: DUE, last_result: null, failures: 0, run_id: null });
const removedId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Predecessor A term 0: `removed` ids each created, claimed once and removed at `removedAt(i)`; ID stays live. */
function handover(removed: number, removedAt: (i: number) => number) {
  const rows: Row[] = [];
  let seq = 0;
  const add = (ts: number, text: string) => {
    seq++;
    rows.push({ id: `${A}:${String(seq).padStart(6, "0")}`, origin: A, seq, ts, json: JSON.stringify({ body: { text } }) });
  };
  add(DUE - 3 * HOUR, PREFIX + JSON.stringify({ op: "put", term: 0, rev: 1, schedule: sched(ID, "Live") }));
  add(DUE - 10 * MIN, CLAIM_PREFIX + JSON.stringify({ schedule: ID, slot: DUE - 10 * MIN, run: uuid(1), epoch: 1, holder: A,
    term: 0, after: null, at: DUE - 10 * MIN, checks: {} }));
  for (let i = 0; i < removed; i++) {
    const id = removedId(i), at = removedAt(i);
    add(at - 2 * HOUR, PREFIX + JSON.stringify({ op: "put", term: 0, rev: 1, schedule: sched(id, `Gone ${i}`) }));
    add(at - HOUR, CLAIM_PREFIX + JSON.stringify({ schedule: id, slot: at - HOUR, run: uuid(1_000 + i), epoch: 1, holder: A,
      term: 0, after: null, at: at - HOUR, checks: {} }));
    add(at, PREFIX + JSON.stringify({ op: "remove", term: 0, rev: 2, id }));
  }
  const terms: Term[] = [{ authority: A, after: null, floor: 0, ceiling: seq + 1 }, { authority: B, after: "transfer:1", floor: 0, ceiling: null }];
  const wall = { value: NOW };
  const b = fixture(B, 1, rows, terms, wall, { [A]: seq, [B]: 0 }, { [A]: seq });
  return { b, rows, wall };
}
const storedIds = (b: ReturnType<typeof handover>["b"]) => new Set(loadScheduleClaims(b.core, 1).map((c) => c.schedule));

test("R13-3a more than 1,000 removed ids do not stop claims; the newest removals are kept, the oldest evicted", () => {
  const { b, wall } = handover(1_200, (i) => NOW - 2 * HOUR - i * 1_000);
  const result = b.lead.claimFromPeer(B, { schedule: ID, slot: DUE, run: uuid(2), epoch: b.epoch });
  expect(result.claimed).toBe(true);
  const stored = loadScheduleClaims(b.core, 1);
  expect(stored.length).toBeLessThanOrEqual(CAP);
  const ids = storedIds(b);
  expect(ids.has(ID)).toBe(true);
  expect(stored.filter((c) => c.schedule === ID).length).toBe(2);
  expect(ids.has(removedId(0))).toBe(true);
  expect(ids.has(removedId(1_199))).toBe(false);
  expect(stored.length).toBe(CAP);
  // A later claim after the eviction still works and still does not exceed the cap.
  const next = DUE + 5 * MIN;
  wall.value = next + 1_000;
  b.core.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 1, after: "transfer:1", rev: 2, schedule: { ...sched(ID, "Live"), last_run: DUE, next_run: next } }) },
    { channel: "talkie-schedules" });
  const again = b.lead.claimFromPeer(B, { schedule: ID, slot: next, run: uuid(3), epoch: b.epoch });
  expect(again.claimed).toBe(true);
  expect(loadScheduleClaims(b.core, 1).length).toBeLessThanOrEqual(CAP);
});

test("R13-3b a removed id's newest claim is dropped once 48 h have passed since its removal, and kept before that", () => {
  const { b } = handover(4, (i) => [NOW - 49 * HOUR, NOW - 47 * HOUR, NOW - 48 * HOUR, NOW - 10 * MIN][i]!);
  expect(b.lead.claimFromPeer(B, { schedule: ID, slot: DUE, run: uuid(2), epoch: b.epoch }).claimed).toBe(true);
  const ids = storedIds(b);
  expect(ids.has(removedId(0))).toBe(false); // removed 49 h ago
  expect(ids.has(removedId(1))).toBe(true);  // removed 47 h ago
  expect(ids.has(removedId(2))).toBe(false); // exactly 48 h: the window is over
  expect(ids.has(removedId(3))).toBe(true);
  expect(loadScheduleClaims(b.core, 1).filter((c) => c.schedule === removedId(1))).toHaveLength(1);
});

test("R13-3c compactClaims never evicts a live schedule's record: 20 live ids x 50 records fill the cap and no removed id fits", () => {
  const claim = (schedule: string, seq: number, at: number): StoredClaim => ({ schedule, slot: at, run: uuid(seq), epoch: 1, holder: A,
    term: 1, after: "transfer:1", at, checks: {}, origin: B, seq });
  const live = Array.from({ length: 20 }, (_v, n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  const claims: StoredClaim[] = [];
  let seq = 0;
  for (const id of live) for (let k = 0; k < CLAIMS_PER_SCHEDULE; k++) claims.push(claim(id, ++seq, NOW - k * MIN));
  const removedAt = new Map<string, number>();
  for (let i = 0; i < 300; i++) { const id = removedId(i); removedAt.set(id, NOW - HOUR - i); claims.push(claim(id, ++seq, NOW - HOUR)); }
  const kept = compactClaims(claims, NOW, { live: new Set(live), removedAt });
  expect(kept.length).toBe(CAP);
  expect(kept.every((c) => live.includes(c.schedule))).toBe(true);
  // With room, removed ids fill it newest-removal first and each keeps only its newest record.
  const fewer = compactClaims(claims.filter((c) => c.schedule !== live[19]), NOW, { live: new Set(live.slice(0, 19)), removedAt });
  expect(fewer.length).toBe(CAP);
  const removedKept = fewer.filter((c) => !live.includes(c.schedule)).map((c) => c.schedule);
  expect(removedKept).toHaveLength(CAP - 19 * CLAIMS_PER_SCHEDULE);
  expect(new Set(removedKept).size).toBe(removedKept.length);
  expect(removedKept).toContain(removedId(0));
  expect(removedKept).not.toContain(removedId(299));
});
