import { afterEach, expect, test } from "bun:test";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { CLAIMS_PER_SCHEDULE, CLAIM_RETENTION_MS, ScheduleClaim, compactClaims, saveScheduleClaims,
  signedClaimRecords, type StoredClaim } from "../../src/daemon/orchestrator/schedule-claims.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import type { Core } from "../../src/daemon/core.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const A = "a".repeat(16), B = "b".repeat(16), C = "c".repeat(16);
const ID = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const PREFIX = "walkie-talkie-schedule:v1:";
const CLAIM_PREFIX = "walkie-talkie-claim:v1:";
const DUE = 36_000_000; // 10:00, on a five-minute cron boundary
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

type Row = { id: string; origin: string; seq: number; ts: number; json: string };
type Term = { authority: string; after: string | null; floor: number; ceiling: number | null };

function fixture(node: string, term: number, rows: Row[], terms: Term[], wall: { value: number },
  vv: Record<string, number>, wm: Record<string, number> | null) {
  const meta = new Map<string, string>();
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: "alex", last_run: null, next_run: DUE, last_result: null, failures: 0, run_id: null };
  if (!rows.length) rows.push({ id: "seed:1", origin: A, seq: 1, ts: DUE - 300_000,
    json: JSON.stringify({ body: { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) } }) });
  let mono = 0;
  const audit = { fail: false, posts: [] as string[] };
  const core = {
    nodeId: node, authority: node, authorityLeaseTerm: term, authorityTransferWatermark: wm,
    teamId: "team", hostname: "authority", me: () => ({ handle: "alex", role: "owner" }), myHandle: () => "alex",
    authorityClaimTerms: terms, isAuthority: () => true,
    roster: { nodes: new Map([node, ...rows.map((row) => row.origin)].map((id) => [id, { node_id: id, login: "alex" }])), members: new Map([["alex", { role: "owner", handle: "alex" }]]),
      channels: new Map([[SCHEDULE_CHANNEL, { members: ["alex"] }], ["general", {}]]) },
    store: { claimIndexReady: true, getMeta: (key: string) => meta.get(key) ?? null,
      setMeta: (key: string, value: string) => { meta.set(key, value); },
      deleteMeta: (key: string) => { meta.delete(key); },
      transaction: (fn: () => unknown) => fn(), vv: () => vv,
      channelEventCount: () => rows.length,
      queryEvents: (filter: { since_ts?: number }) => rows
        .filter((row) => filter.since_ts === undefined || row.ts > filter.since_ts)
        .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
        .map((row) => ({ ...row, json: JSON.stringify({ ...JSON.parse(row.json), author: { handle: "alex" } }) })),
      scheduleClaimEvents: (schedule: string, since: number, limit: number) => {
        const matched = rows.flatMap((row) => {
          const text = JSON.parse(row.json).body.text as string;
          if (!text.startsWith(CLAIM_PREFIX)) return [];
          const claim = JSON.parse(text.slice(CLAIM_PREFIX.length)) as StoredClaim;
          return claim.schedule === schedule ? [{ row, claim }] : [];
        }).sort((a, b) => b.claim.term - a.claim.term || b.row.seq - a.row.seq);
        return matched.slice(0, limit).filter(({ claim }, index) => index === 0 || claim.at >= since)
          .map(({ row }) => row);
      } },
    emit: (_kind: string, body: { text: string }, opts?: { agent?: string }) => {
      if (opts?.agent === "walkie-admin") {
        if (audit.fail) throw new Error("audit transport failed");
        audit.posts.push(body.text);
      }
      const seq = (vv[node] ?? 0) + 1;
      vv[node] = seq;
      const row = { id: `${node}:${seq}`, origin: node, seq, ts: wall.value, json: JSON.stringify({ body }) };
      rows.push(row);
      return row;
    },
    log: { warn: () => {} },
  } as unknown as Core;
  const lead = new Leadership({ core, preferred: () => node, lost: () => {}, now: () => wall.value,
    monoNow: () => mono });
  mono = 34_000;
  const epoch = lead.grant(node).epoch;
  return { core, lead, epoch, meta, audit };
}

function reset(core: Core, at: number) {
  return new Schedules(core, { valid: () => true, claim: async () => false, turn: () => "",
    reply: () => null, interrupt: () => {} }).reset(ID, at);
}

function claimPosts(rows: Row[]): Array<StoredClaim & { refusal_floor?: number }> {
  return rows.flatMap((row) => {
    const text = JSON.parse(row.json).body.text as string;
    return text.startsWith(CLAIM_PREFIX) ? [JSON.parse(text.slice(CLAIM_PREFIX.length))] : [];
  });
}

test("a signed claim survives a nine-minute rollback and refuses the same slot after handover", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const old = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  expect(old.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: old.epoch }).claimed).toBe(true);
  const post = rows.find((row) => JSON.parse(row.json).body.text.startsWith(CLAIM_PREFIX));
  expect(post?.origin).toBe(A);
  const transferWm = { [A]: post!.seq };
  wall.value -= 9 * 60_000;
  const successorRows = [...rows];
  const successor = fixture(B, 1, successorRows, [
    { authority: A, after: null, floor: 0, ceiling: post!.seq + 1 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], wall, { [A]: post!.seq, [B]: 1 }, transferWm);
  wall.value = DUE;
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: DUE,
    run: "33333333-3333-4333-8333-333333333333", epoch: successor.epoch }).claimed).toBe(false);
});

test("more than fifty later signed claims cannot reopen an older slot on stale schedule state", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  for (let i = 0; i < CLAIMS_PER_SCHEDULE + 2; i++) {
    const seq = i + 2;
    const slot = i === 0 ? DUE : DUE + 60_000;
    rows.push({ id: `${A}:${seq}`, origin: A, seq, ts: slot,
      json: JSON.stringify({ body: { text: CLAIM_PREFIX + JSON.stringify({ schedule: ID, slot, run: RUN,
        epoch: 1, holder: A, term: 0, after: null, at: slot, checks: {} }) } }) });
  }
  const last = rows.at(-1)!;
  const successor = fixture(B, 1, [...rows], [
    { authority: A, after: null, floor: 0, ceiling: last.seq + 1 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], wall, { [A]: last.seq, [B]: 1 }, { [A]: last.seq });
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: DUE,
    run: "33333333-3333-4333-8333-333333333333", epoch: successor.epoch }))
    .toEqual({ claimed: false, reason: "just_ran" });
});

test("claims wait until the resumable claim index is complete", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  current.core.store.claimIndexReady = false;
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: current.epoch }))
    .toEqual({ claimed: false, reason: "migration_pending" });
  current.core.store.claimIndexReady = true;
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: current.epoch }).claimed).toBe(true);
});

test("future high-water mark blocks claims, shows one alert, and reset resumes at the next slot", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  rows.push({ id: `${A}:2`, origin: A, seq: 2, ts: DUE,
    json: JSON.stringify({ body: { text: CLAIM_PREFIX + JSON.stringify({ schedule: ID, slot: DUE + 2 * 60 * 60_000,
      run: RUN, epoch: 1, holder: A, term: 0, after: null, at: DUE, checks: {} }) } }) });
  const vv = current.core.store.vv() as Record<string, number>;
  vv[A] = 2;
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: current.epoch }))
    .toEqual({ claimed: false, reason: "clock_error" });
  expect(rows.filter((row) => row.json.includes("claimed slot is in the future (clock error)"))).toHaveLength(2);
  current.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: current.epoch });
  expect(rows.filter((row) => row.json.includes("claimed slot is in the future (clock error)"))).toHaveLength(2);
  const updated = reset(current.core, DUE);
  expect(updated.next_run).toBe(DUE + 5 * 60_000);
  expect(rows.some((row) => JSON.parse(row.json).body.text.startsWith(CLAIM_PREFIX)
    && JSON.parse(JSON.parse(row.json).body.text.slice(CLAIM_PREFIX.length)).reset === true)).toBe(true);
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: current.epoch }))
    .toEqual({ claimed: false, reason: "just_ran" });
  wall.value = DUE + 5 * 60_000;
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: wall.value, run: RUN, epoch: current.epoch }).claimed).toBe(true);
});

test("reset drops a last_run three hours ahead so the next slot can be claimed", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  rows.push({ id: `${A}:2`, origin: A, seq: 2, ts: DUE,
    json: JSON.stringify({ body: { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule: {
      id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" },
      enabled: true, created_by: "alex", next_run: DUE, last_result: null, failures: 0, run_id: RUN,
      last_run: DUE + 3 * 60 * 60_000,
    } }) } }) });
  const updated = reset(current.core, DUE);
  expect(updated.next_run).toBe(DUE + 5 * 60_000);
  expect(claimPosts(rows).at(-1)?.refusal_floor).toBe(DUE);
  wall.value = updated.next_run!;
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: wall.value, run: RUN, epoch: current.epoch }))
    .toMatchObject({ claimed: true });
});

test("reset drops an inherited far-future refusal floor", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  saveScheduleClaims(current.core, 0, [{ schedule: ID, slot: 0, run: RUN, epoch: current.epoch,
    holder: A, term: 0, after: null, at: DUE, checks: {}, reset: true,
    refusal_floor: DUE + 3 * 60 * 60_000, origin: A, seq: 2 }]);
  (current.core.store.vv() as Record<string, number>)[A] = 2;
  const updated = reset(current.core, DUE);
  expect(claimPosts(rows).at(-1)?.refusal_floor).toBe(DUE);
  wall.value = updated.next_run!;
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: wall.value, run: RUN, epoch: current.epoch }))
    .toMatchObject({ claimed: true });
});

test("a second reset waits for correction when the authority clock moves behind its prior reset", () => {
  const rows: Row[] = [];
  const wall = { value: DUE + 3 * 60 * 60_000 };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  reset(current.core, wall.value);
  expect(claimPosts(rows).at(-1)?.refusal_floor).toBe(wall.value);
  wall.value = DUE;
  const count = rows.length;
  expect(() => reset(current.core, wall.value)).toThrow("the schedule resumes on its own at");
  expect(rows).toHaveLength(count);
  wall.value = DUE + 3 * 60 * 60_000;
  const updated = reset(current.core, wall.value);
  expect(claimPosts(rows).at(-1)?.refusal_floor).toBe(wall.value);
  wall.value = updated.next_run!;
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: wall.value, run: RUN, epoch: current.epoch }))
    .toMatchObject({ claimed: true });
});

test("a reset after a small clock step-back keeps a claimed future slot closed", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: current.epoch }).claimed).toBe(true);
  wall.value -= 3 * 60_000;
  reset(current.core, wall.value);
  expect(claimPosts(rows).at(-1)?.refusal_floor).toBe(DUE);
  wall.value = DUE;
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: current.epoch }))
    .toEqual({ claimed: false, reason: "just_ran" });
});

test("reset refuses a missing general channel without changing the schedule", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  (current.core.roster.channels as Map<string, unknown>).delete("general");
  let error: unknown;
  try { reset(current.core, DUE); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ status: 409, code: "audit_unavailable" });
  expect(claimPosts(rows)).toHaveLength(0);
  expect(current.audit.posts).toHaveLength(0);
  expect(new Schedules(current.core, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} }).get(ID).next_run).toBe(DUE);
});

test("audit emit failure refuses reset before its signed claim and schedule update", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  current.audit.fail = true;
  let error: unknown;
  try { reset(current.core, DUE); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ status: 500, code: "audit_failed" });
  expect(claimPosts(rows)).toHaveLength(0);
  expect(rows).toHaveLength(1);
  expect(current.meta.has("orchestrator_claims")).toBe(false);
  expect(current.audit.posts).toHaveLength(0);
});

test("a successful reset records exactly one team audit post", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  reset(current.core, DUE);
  expect(current.audit.posts).toEqual([expect.stringContaining(`reset WalkieTalkie schedule ${ID}`)]);
});

test("reset within a minute of a due slot refuses that slot and schedules strictly after reset", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: current.epoch }).claimed).toBe(true);
  wall.value = DUE + 30_000;
  const updated = reset(current.core, wall.value);
  expect(updated.next_run).toBe(DUE + 5 * 60_000);
  expect(claimPosts(rows).at(-1)).toMatchObject({ reset: true, refusal_floor: wall.value });
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: DUE,
    run: "33333333-3333-4333-8333-333333333333", epoch: current.epoch }))
    .toEqual({ claimed: false, reason: "just_ran" });
  wall.value++;
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: wall.value,
    run: "44444444-4444-4444-8444-444444444444", epoch: current.epoch, run_now: true }).claimed).toBe(true);
});

test("repeating reset cannot lower its signed refusal floor or reopen a slot", () => {
  const rows: Row[] = [];
  const wall = { value: DUE + 30_000 };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  reset(current.core, wall.value);
  const first = claimPosts(rows).at(-1)!.refusal_floor;
  reset(current.core, wall.value);
  expect(claimPosts(rows).at(-1)!.refusal_floor).toBe(first);
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: current.epoch }))
    .toEqual({ claimed: false, reason: "just_ran" });
});

test("a later claim carries the reset floor past the bounded tail while excluding far-future slots", () => {
  const rows: Row[] = [];
  const wall = { value: DUE + 30_000 };
  const current = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  reset(current.core, wall.value);
  const firstFloor = wall.value;
  wall.value = DUE + 5 * 60_000;
  expect(current.lead.claimFromPeer(A, { schedule: ID, slot: wall.value, run: RUN, epoch: current.epoch }).claimed).toBe(true);
  expect(claimPosts(rows).at(-1)!.refusal_floor).toBe(firstFloor);
  const vv = current.core.store.vv() as Record<string, number>;
  for (let n = 0; n < CLAIMS_PER_SCHEDULE + 1; n++) {
    const seq = ++vv[A]!;
    rows.push({ id: `${A}:${seq}`, origin: A, seq, ts: wall.value,
      json: JSON.stringify({ body: { text: CLAIM_PREFIX + JSON.stringify({ schedule: ID,
        slot: wall.value + (n + 1) * 300_000, run: RUN, epoch: current.epoch,
        holder: A, term: 0, after: null, at: wall.value, checks: {}, refusal_floor: firstFloor }) } }) });
  }
  current.meta.delete("orchestrator_claims"); // daemon restart: seed from the signed indexed tail only
  wall.value = DUE + 10_000;
  reset(current.core, wall.value);
  expect(claimPosts(rows).at(-1)!.refusal_floor).toBe(DUE + 60 * 60_000);
});

test("a successor uses the signed reset floor when schedule state is stale", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const old = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  expect(old.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: old.epoch }).claimed).toBe(true);
  wall.value = DUE + 30_000;
  reset(old.core, wall.value);
  const latest = rows.at(-2)!; // reset claim precedes the schedule update
  const successorRows = rows.filter((row) => row.id !== rows.at(-1)!.id);
  const successor = fixture(B, 1, successorRows, [
    { authority: A, after: null, floor: 0, ceiling: latest.seq + 2 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], wall, { [A]: latest.seq, [B]: 1 }, { [A]: latest.seq });
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: DUE,
    run: "33333333-3333-4333-8333-333333333333", epoch: successor.epoch }))
    .toEqual({ claimed: false, reason: "just_ran" });
  successorRows.push(rows.at(-1)!);
  wall.value = DUE + 5 * 60_000;
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: wall.value,
    run: "44444444-4444-4444-8444-444444444444", epoch: successor.epoch }).claimed).toBe(true);
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: wall.value,
    run: "55555555-5555-4555-8555-555555555555", epoch: successor.epoch }))
    .toEqual({ claimed: false, reason: "just_ran" });
});

test("a two-minute-behind successor refuses an earlier run-now below T", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const old = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  expect(old.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: old.epoch }).claimed).toBe(true);
  const post = rows.find((row) => JSON.parse(row.json).body.text.startsWith(CLAIM_PREFIX))!;
  wall.value = DUE - 2 * 60_000;
  const successor = fixture(B, 1, [...rows], [
    { authority: A, after: null, floor: 0, ceiling: post.seq + 1 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], wall, { [A]: post.seq, [B]: 1 }, { [A]: post.seq });
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: wall.value,
    run: "33333333-3333-4333-8333-333333333333", epoch: successor.epoch, run_now: true }))
    .toEqual({ claimed: false, reason: "just_ran" });
  expect(JSON.parse(successor.meta.get("orchestrator_claims")!).claims.map((claim: StoredClaim) => claim.slot))
    .toContain(DUE);
  wall.value = DUE;
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: DUE,
    run: "44444444-4444-4444-8444-444444444444", epoch: successor.epoch }).claimed).toBe(false);
});

test("an eight-day-old latest claim still refuses its slot after handover", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const old = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  expect(old.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: old.epoch }).claimed).toBe(true);
  const claim = rows.find((row) => JSON.parse(row.json).body.text.startsWith(CLAIM_PREFIX))!;
  wall.value = DUE + CLAIM_RETENTION_MS + 24 * 60 * 60_000;
  const successor = fixture(B, 1, [...rows], [
    { authority: A, after: null, floor: 0, ceiling: claim.seq + 1 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], wall, { [A]: claim.seq, [B]: 1 }, { [A]: claim.seq });
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: DUE,
    run: "33333333-3333-4333-8333-333333333333", epoch: successor.epoch }).claimed).toBe(false);
});

test("a successor refuses claims until the previous authority's own stream is covered", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const vv = { [A]: 1, [B]: 1 };
  const successor = fixture(B, 1, rows, [
    { authority: A, after: null, floor: 0, ceiling: 3 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], wall, vv, { [A]: 2 });
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: DUE, run: RUN, epoch: successor.epoch }))
    .toEqual({ claimed: false, reason: "authority_catching_up" });
  expect(rows.at(-1)?.json).not.toContain("authority catching up");
  vv[A] = 2;
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: DUE, run: RUN, epoch: successor.epoch }).claimed).toBe(true);
});

test("a forged claim post signed by a non-authority is ignored", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  rows.push({ id: `${C}:1`, origin: C, seq: 1, ts: DUE, json: JSON.stringify({ body: { text: CLAIM_PREFIX +
    JSON.stringify({ schedule: ID, slot: DUE, run: RUN, holder: A, epoch: 1, term: 0, after: null, at: DUE,
      checks: {} }) } }) });
  const successor = fixture(B, 1, rows, [
    { authority: A, after: null, floor: 0, ceiling: 2 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], wall, { [A]: 2, [B]: 1, [C]: 1 }, { [A]: 2, [C]: 1 });
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: DUE,
    run: "33333333-3333-4333-8333-333333333333", epoch: successor.epoch }).claimed).toBe(true);
});

test("a late first grant and repeated handovers do not starve a due schedule", () => {
  const rows: Row[] = [];
  const wall = { value: DUE + 6 * 60_000 };
  const second = fixture(B, 1, rows, [
    { authority: A, after: null, floor: 0, ceiling: 2 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], wall, { [A]: 2, [B]: 1 }, { [A]: 2 });
  const withSentAt = ScheduleClaim.parse({ schedule: ID, slot: DUE, run: RUN, epoch: second.epoch,
    sent_at: wall.value + 600_000 });
  expect(withSentAt).toEqual({ schedule: ID, slot: DUE, run: RUN, epoch: second.epoch });
  expect(second.lead.claimFromPeer(B, withSentAt).claimed).toBe(true);
  expect(second.lead.claimFromPeer(B, { schedule: ID, slot: DUE, run: RUN, epoch: second.epoch }))
    .toEqual({ claimed: false, reason: "just_ran" });
  const third = fixture(A, 2, rows, [
    { authority: A, after: null, floor: 0, ceiling: 2 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: 3 },
    { authority: A, after: "transfer:2", floor: 2, ceiling: null },
  ], wall, { [A]: 2, [B]: 2 }, { [B]: 2 });
  expect(third.lead.claimFromPeer(A, { schedule: ID, slot: DUE,
    run: "33333333-3333-4333-8333-333333333333", epoch: third.epoch }).claimed).toBe(false);
  const next = DUE + 10 * 60_000;
  const updated = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: "alex", last_run: DUE, next_run: next, last_result: null, failures: 0, run_id: RUN };
  rows.push({ id: `${A}:3`, origin: A, seq: 3, ts: next, json: JSON.stringify({ body: { text: PREFIX +
    JSON.stringify({ op: "put", term: 2, after: "transfer:2", schedule: updated }) } }) });
  wall.value = next;
  expect(third.lead.claimFromPeer(A, { schedule: ID, slot: next,
    run: "44444444-4444-4444-8444-444444444444", epoch: third.epoch }).claimed).toBe(true);
});

test("a claimant-supplied sent_at field cannot opt into a claim security check", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const authority = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }],
    wall, { [A]: 1 }, null);
  const claim = { schedule: ID, slot: DUE, run: RUN, epoch: authority.epoch };
  expect(ScheduleClaim.parse({ ...claim, sent_at: DUE + 10 * 60_000 })).toEqual(claim);
  expect(authority.lead.claimFromPeer(A, ScheduleClaim.parse({ ...claim, sent_at: DUE + 10 * 60_000 })).claimed)
    .toBe(true);
  expect(authority.lead.claimFromPeer(A, claim)).toEqual({ claimed: false, reason: "just_ran" });
});

test("a successor honors per-target checks in signed claims even when the schedule post is delayed", () => {
  const wall = { value: DUE };
  const schedule = { id: ID, name: "Capacity", cron: "*/15 * * * *", task: { template: "capacity-check" },
    enabled: true, created_by: "alex", last_run: null, next_run: DUE, last_result: null, failures: 0,
    run_id: null, capacity_checked_at: {} };
  const rows: Row[] = [{ id: `${A}:1`, origin: A, seq: 1, ts: DUE - 60_000,
    json: JSON.stringify({ body: { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) } }) }];
  const old = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }], wall, { [A]: 1 }, null);
  expect(old.lead.claimFromPeer(A, { schedule: ID, slot: DUE, run: RUN, epoch: old.epoch,
    capacity_targets: ["node-target"] })).toMatchObject({ claimed: true, capacity_targets: ["node-target"] });
  const oldClaim = rows.find((row) => JSON.parse(row.json).body.text.startsWith(CLAIM_PREFIX))!;
  expect(JSON.parse(JSON.parse(oldClaim.json).body.text.slice(CLAIM_PREFIX.length)).checks).toEqual({ "node-target": DUE });
  const next = DUE + 15 * 60_000;
  rows.push({ id: `${A}:3`, origin: A, seq: 3, ts: next - 1,
    json: JSON.stringify({ body: { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule: {
      ...schedule, last_run: DUE, next_run: next, run_id: RUN,
    } }) } }) });
  wall.value = next;
  const successor = fixture(B, 1, rows, [
    { authority: A, after: null, floor: 0, ceiling: 4 },
    { authority: B, after: "transfer:1", floor: 0, ceiling: null },
  ], wall, { [A]: 3, [B]: 1 }, { [A]: 3 });
  expect(successor.lead.claimFromPeer(B, { schedule: ID, slot: next,
    run: "33333333-3333-4333-8333-333333333333", epoch: successor.epoch,
    capacity_targets: ["node-target"] })).toMatchObject({ claimed: true });
  const newClaim = rows.at(-1)!;
  expect(JSON.parse(JSON.parse(newClaim.json).body.text.slice(CLAIM_PREFIX.length)).checks).toEqual({});
});

test("claim history keeps seven days and at most the latest 50 records per schedule", () => {
  const now = DUE + CLAIM_RETENTION_MS;
  const base = { schedule: ID, slot: DUE, run: RUN, epoch: 1, holder: A, term: 0,
    after: null, at: now - 1, checks: {}, origin: A };
  const claims = Array.from({ length: CLAIMS_PER_SCHEDULE + 1 }, (_, i) => ({ ...base, seq: i + 2 }));
  const old: StoredClaim = { ...base, seq: 1, at: now - CLAIM_RETENTION_MS - 1 };
  const kept = compactClaims([...claims, old], now);
  expect(kept).toHaveLength(CLAIMS_PER_SCHEDULE);
  expect(kept[0]?.seq).toBe(CLAIMS_PER_SCHEDULE + 2);
  expect(kept.at(-1)?.seq).toBe(3);
  expect(compactClaims([{ ...old, seq: 2 }, old], now)).toEqual([{ ...old, seq: 2 }]);
});

test("an expired claim inside the latest 50 does not pull older claims back into the set", () => {
  const now = DUE + CLAIM_RETENTION_MS + 1;
  const base = { schedule: ID, slot: DUE, run: RUN, epoch: 1, holder: A, term: 0,
    after: null, at: now - 1, checks: {}, origin: A };
  const claims: StoredClaim[] = Array.from({ length: CLAIMS_PER_SCHEDULE + 1 }, (_, i) => ({
    ...base, seq: i + 1, at: i === CLAIMS_PER_SCHEDULE - 1 ? DUE : now - 1,
  }));
  const kept = compactClaims(claims, now);
  expect(kept).toHaveLength(CLAIMS_PER_SCHEDULE - 1);
  expect(kept.map((claim) => claim.seq)).not.toContain(1);
  expect(kept[0]?.seq).toBe(CLAIMS_PER_SCHEDULE + 1);
});

test("seeding asks for bounded indexed claims per schedule, including its old latest", () => {
  const old: StoredClaim = { schedule: ID, slot: DUE, run: RUN, epoch: 1, holder: A, term: 0,
    after: null, at: DUE, checks: {}, origin: A, seq: 2 };
  const calls: { schedule: string; since: number; limit: number }[] = [];
  const core = { authorityClaimTerms: [{ authority: A, after: null, floor: 0, ceiling: null }],
    store: {
      queryEvents: () => { throw new Error("unbounded channel scan"); },
      scheduleClaimEvents: (schedule: string, since: number, limit: number) => {
        calls.push({ schedule, since, limit });
        return [{ id: `${A}:2`, origin: A, seq: 2, json: JSON.stringify({ body: {
          text: CLAIM_PREFIX + JSON.stringify(old),
        } }) }];
      },
    } } as unknown as Core;
  expect(signedClaimRecords(core, DUE + CLAIM_RETENTION_MS + 1, [ID])).toEqual([old]);
  expect(calls).toEqual([{ schedule: ID, since: DUE + 1, limit: CLAIMS_PER_SCHEDULE }]);
});

test("durable last_run refuses a stale due slot without a claim record", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const authority = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }],
    wall, { [A]: 1 }, null);
  rows.push({ id: `${A}:2`, origin: A, seq: 2, ts: DUE,
    json: JSON.stringify({ body: { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule: {
      id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
      created_by: "alex", last_run: DUE, next_run: DUE, last_result: null, failures: 0, run_id: RUN,
    } }) } }) });
  expect(authority.lead.claimFromPeer(A, { schedule: ID, slot: DUE,
    run: "33333333-3333-4333-8333-333333333333", epoch: authority.epoch }).claimed).toBe(false);
});

test("a far-future local slot blocks the schedule until a person resets it", () => {
  const rows: Row[] = [];
  const wall = { value: DUE };
  const authority = fixture(A, 0, rows, [{ authority: A, after: null, floor: 0, ceiling: null }],
    wall, { [A]: 1 }, null);
  saveScheduleClaims(authority.core, 0, [{ schedule: ID, slot: DUE + CLAIM_RETENTION_MS, run: RUN,
    epoch: authority.epoch, holder: A, term: 0, after: null, at: DUE, checks: {}, origin: A, seq: 1 }]);
  expect(authority.lead.claimFromPeer(A, { schedule: ID, slot: DUE,
    run: "33333333-3333-4333-8333-333333333333", epoch: authority.epoch }))
    .toEqual({ claimed: false, reason: "clock_error" });
  expect(JSON.parse(authority.meta.get("orchestrator_claims")!).claims.map((claim: StoredClaim) => claim.slot))
    .toEqual([DUE + CLAIM_RETENTION_MS]);
});

test("real Core commits one admin post before the reset claim and schedule update", () => {
  const owner = tnode("alex");
  const { team, create } = createTeam(owner);
  const core = makeCore(owner, team, cleanups);
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL });
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: owner.handle, last_run: null, next_run: DUE, last_result: null, failures: 0, run_id: null };
  core.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) }, { channel: SCHEDULE_CHANNEL });
  reset(core, now());
  const audit = core.store.queryEvents({ channel: "general", kinds: ["msg.post"], limit: 10 });
  const claims = core.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 10 })
    .filter((row) => JSON.parse(row.json).body.text.startsWith(CLAIM_PREFIX));
  expect(audit).toHaveLength(1);
  expect(JSON.parse(audit[0]!.json).author.agent).toBe("walkie-admin");
  expect(claims).toHaveLength(1);
  expect(audit[0]!.seq).toBeLessThan(claims[0]!.seq);
});

test("real Core signs and stores a claim before transfer; the successor verifies its term", () => {
  const a = tnode("alex"), b = tnode("bea");
  const { team, create } = createTeam(a);
  const first = makeCore(a, team, cleanups);
  first.ingest(create, "local");
  const member = first.emit("team.member", { login: b.login, handle: b.handle, role: "owner" });
  const node = first.emit("team.node", { node_id: b.keys.nodeId, login: b.login, hostname: b.hostname,
    pubkey: b.keys.pubkey, ip: "127.0.0.1" });
  const channel = first.emit("channel.upsert", { name: SCHEDULE_CHANNEL });
  const slot = Math.floor(now() / 300_000) * 300_000;
  const schedule = { id: ID, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: a.handle, last_run: null, next_run: slot, last_result: null, failures: 0, run_id: null };
  const put = first.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule }) },
    { channel: SCHEDULE_CHANNEL });
  const nextId = "55555555-5555-4555-8555-555555555555";
  const nextSlot = slot + 300_000;
  const nextPut = first.emit("msg.post", { text: PREFIX + JSON.stringify({ op: "put", term: 0, schedule: {
    ...schedule, id: nextId, name: "Next", next_run: nextSlot,
  } }) }, { channel: SCHEDULE_CHANNEL });
  const old = new Leadership({ core: first, preferred: () => first.nodeId, lost: () => {}, now: () => now() });
  const epoch = old.grant(first.nodeId).epoch;
  expect(old.claimFromPeer(first.nodeId, { schedule: ID, slot, run: RUN, epoch }).claimed).toBe(true);
  const claim = first.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 10 })
    .find((row) => JSON.parse(row.json).body.text.startsWith(CLAIM_PREFIX));
  expect(claim?.origin).toBe(first.nodeId);
  const transfer = first.emit("team.authority", { node_id: b.keys.nodeId });
  expect(first.authorityTransferWatermark?.[first.nodeId]).toBeGreaterThanOrEqual(claim!.seq);
  const successor = makeCore(b, team, cleanups);
  feed(successor, [create, member, node, channel, put, nextPut,
    JSON.parse(claim!.json), transfer]);
  expect(successor.authority).toBe(b.keys.nodeId);
  expect(successor.authorityClaimTerms[0]?.ceiling).toBe(transfer.seq);
  let mono = 0;
  const next = new Leadership({ core: successor, preferred: () => successor.nodeId, lost: () => {},
    now: () => slot + 6 * 60_000, monoNow: () => mono });
  mono = 34_000;
  const nextEpoch = next.grant(successor.nodeId).epoch;
  expect(next.claimFromPeer(successor.nodeId, { schedule: ID, slot,
    run: "33333333-3333-4333-8333-333333333333", epoch: nextEpoch }).claimed).toBe(false);
  expect(next.claimFromPeer(successor.nodeId, { schedule: nextId, slot: nextSlot,
    run: "44444444-4444-4444-8444-444444444444", epoch: nextEpoch }).claimed).toBe(true);
});
