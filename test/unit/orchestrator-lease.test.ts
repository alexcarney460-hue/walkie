import { expect, test } from "bun:test";
import { LeaseAuthority, LeaseHolder } from "../../src/daemon/orchestrator/lease.ts";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { CLAIM_SKEW_MS, ScheduleClaim } from "../../src/daemon/orchestrator/schedule-claims.ts";
import type { Core } from "../../src/daemon/core.ts";
const A = "a".repeat(16), B = "b".repeat(16);

test("Run Now claim requests ignore newer optional fields but validate known fields", () => {
  const claim = { schedule: "11111111-1111-4111-8111-111111111111", slot: 900_000,
    run: "22222222-2222-4222-8222-222222222222", epoch: 1, run_now: true,
    newer_claim_field: "optional" };
  expect(ScheduleClaim.parse(claim)).toEqual({ schedule: claim.schedule, slot: claim.slot,
    run: claim.run, epoch: claim.epoch, run_now: true });
  expect(ScheduleClaim.safeParse({ ...claim, run_now: "yes" }).success).toBe(false);
});

test("partition: two candidates elect themselves, but only the authority's unexpired lease can act", () => {
  let now = 0; let disk: string | null = null;
  const book = new LeaseAuthority({ load: () => disk, save: (s) => { disk = s; }, now: () => now, wallNow: () => now, ttl: 30000 });
  let aStops = 0, bStops = 0;
  const a = new LeaseHolder({ self: A, now: () => now, wallNow: () => now, lost: () => { aStops++; } });
  const b = new LeaseHolder({ self: B, now: () => now, wallNow: () => now, lost: () => { bStops++; } });
  const first = book.grant(A, B, B); b.accept(first, now, A);
  expect(b.valid(A)).toBe(true);
  // Partition: B cannot renew; authority A wants to lead but may not preempt B.
  for (now = 1000; now <= 60000; now += 1000) {
    a.accept(book.grant(A, A, A), now, A);
    a.check(A); b.check(A);
    expect(Number(a.valid(A)) + Number(b.valid(A))).toBeLessThanOrEqual(1);
  }
  expect(bStops).toBe(1);
  expect(aStops).toBe(0);
  expect(a.valid(A)).toBe(true);
  // If authority becomes unreachable too, neither can create a replacement lease.
  now += 30000; a.check(A); b.check(A);
  expect(a.valid(A) || b.valid(A)).toBe(false);
});

test("restart quarantine, epoch fencing and delayed replies fail closed", () => {
  let now = 0; let disk: string | null = null;
  const o = { load: () => disk, save: (s: string) => { disk = s; }, now: () => now, wallNow: () => now, ttl: 30000 };
  const book = new LeaseAuthority(o);
  const grant = book.grant(A, A, A);
  const restarted = new LeaseAuthority(o);
  expect(restarted.grant(A, B, B).granted).toBe(false);
  now = 33001;
  const next = restarted.grant(A, B, B);
  expect(next.epoch).toBeGreaterThan(grant.epoch);
  const holder = new LeaseHolder({ self: A, now: () => now, wallNow: () => now, lost: () => {} });
  expect(holder.accept(grant, 0, A)).toBe(false);
  expect(holder.accept(grant, now, A, 0)).toBe(false); // delayed reply cannot extend send-time authority
  expect(holder.accept({ ...grant, expires_at: now + 30000 }, now, A)).toBe(true);
  holder.accept(next, now, A);
  expect(holder.valid(A)).toBe(false);
  expect(holder.accept(grant, now, A)).toBe(false);
  expect(holder.accept(next, now, B)).toBe(false);
});

test("a failed durable write never grants a lease; an authority transfer waits out the former authority", () => {
  let now = 0;
  const broken = new LeaseAuthority({ load: () => null, save: () => { throw new Error("disk unavailable"); }, now: () => now, wallNow: () => now, ttl: 30000 });
  expect(() => broken.grant(A, A, A)).toThrow("disk unavailable");
  const transferred = new LeaseAuthority({ load: () => null, save: () => {}, now: () => now, wallNow: () => now, ttl: 30000, epochFloor: 1_000_000_000, quarantine: true });
  expect(transferred.grant(B, B, B).granted).toBe(false);
  now = 33001;
  expect(transferred.grant(B, B, B)).toMatchObject({ granted: true, epoch: 1_000_000_001 });
});

test("sleeping holder is fenced when only wall time advances", () => {
  let mono = 0, wall = 1_000_000;
  const book = new LeaseAuthority({ load: () => null, save: () => {}, now: () => wall, wallNow: () => wall, ttl: 30000 });
  const b = new LeaseHolder({ self: B, now: () => mono, wallNow: () => wall, lost: () => {} });
  expect(b.accept(book.grant(A, B, B), mono, A)).toBe(true);
  wall += 360_000;
  const c = new LeaseHolder({ self: A, now: () => wall, wallNow: () => wall, lost: () => {} });
  expect(c.accept(book.grant(A, A, A), wall, A)).toBe(true);
  expect(b.valid(A)).toBe(false);
  expect(b.remaining()).toBe(0);
});

test("authority holds off a successor through the supervisor kill and skew window", () => {
  let now = 0;
  const book = new LeaseAuthority({ load: () => null, save: () => {}, now: () => now, wallNow: () => now, ttl: 30000 });
  book.grant(A, B, B);
  now = 30_001;
  expect(book.grant(A, A, A).granted).toBe(false);
  now = 33_001;
  expect(book.grant(A, A, A).granted).toBe(true);
});

test("authority durably rejects a second run claim for the same due slot and refuses forged claims", () => {
  const clock = { value: Date.now() };
  const meta = new Map<string, string>();
  const events: Array<{ id: string; ts: number; json: string }> = [];
  const due = Math.floor(clock.value / 300_000) * 300_000 - 600_000;
  const id = "11111111-1111-4111-8111-111111111111";
  events.push({ id: "schedule", ts: due, json: JSON.stringify({ body: { text: `walkie-talkie-schedule:v1:${JSON.stringify({ op: "put", term: 0, schedule: {
    id, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true, created_by: "alex",
    last_run: null, next_run: due, last_result: null, failures: 0, run_id: null,
  } })}` } }) });
  events.push({ id: "forged", ts: due + 1, json: JSON.stringify({ body: {
    text: `walkie-talkie-claim:v1:${JSON.stringify({ schedule: id, slot: Number.MAX_SAFE_INTEGER,
      run: "44444444-4444-4444-8444-444444444444", epoch: 1 })}` } }) });
  const core = {
    nodeId: A, authority: A, authorityLeaseTerm: 0, isAuthority: () => true,
    authorityTransferWatermark: null,
    authorityClaimTerms: [{ authority: A, after: null, floor: 0, ceiling: null }],
    roster: { nodes: new Map([[A, { node_id: A, login: "alex" }]]), members: new Map([["alex", { role: "owner", handle: "alex" }]]) },
    store: { claimIndexReady: true, getMeta: (key: string) => meta.get(key) ?? null, setMeta: (key: string, value: string) => { meta.set(key, value); },
      transaction: (fn: () => unknown) => fn(), vv: () => ({ [A]: events.length }),
      channelEventCount: () => events.length, queryEvents: () => [...events].reverse().map((row) => ({ ...row, origin: A, seq: 1, json: JSON.stringify({ ...JSON.parse(row.json), author: { handle: "alex" } }) })),
      scheduleClaimEvents: () => [] },
    emit: (_kind: string, body: { text: string }) => {
      const seq = events.length + 1;
      events.push({ id: `${A}:${seq}`, ts: events.length, json: JSON.stringify({ body }) });
      return { origin: A, seq };
    },
  } as unknown as Core;
  const lease = new Leadership({ core, preferred: () => A, lost: () => {}, now: () => clock.value });
  const grant = lease.grant(A);
  const first = { schedule: id, slot: due, run: "22222222-2222-4222-8222-222222222222", epoch: grant.epoch };
  expect(lease.claimFromPeer(B, first).claimed).toBe(false);
  expect(lease.claimFromPeer(A, { ...first, epoch: grant.epoch + 1 }).claimed).toBe(false);
  expect(lease.claimFromPeer(A, { ...first, slot: due + 60 * 60_000 }).claimed).toBe(false);
  expect(lease.claimFromPeer(A, first).claimed).toBe(true);
  expect(lease.claimFromPeer(A, { ...first, run: "33333333-3333-4333-8333-333333333333" }).claimed).toBe(false);
  expect(lease.claimFromPeer(A, first)).toEqual({ claimed: false, reason: "just_ran" });
  expect(events).toHaveLength(3);
  expect(JSON.parse(meta.get("orchestrator_claims") ?? "{}").claims).toHaveLength(1);
  const nextDue = due + 300_000;
  events.push({ id: "next", ts: nextDue, json: JSON.stringify({ body: { text: `walkie-talkie-schedule:v1:${JSON.stringify({ op: "put", term: 0, rev: 1, schedule: {
    id, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true, created_by: "alex",
    last_run: due, next_run: nextDue, last_result: null, failures: 0, run_id: first.run,
  } })}` } }) });
  expect(lease.claimFromPeer(A, { ...first, slot: nextDue }).claimed).toBe(true);
  expect(JSON.parse(meta.get("orchestrator_claims") ?? "{}").claims[0]).toMatchObject({ slot: nextDue });
  const manual = { ...first, slot: clock.value, run: "33333333-3333-4333-8333-333333333333", run_now: true };
  expect(lease.claimFromPeer(A, manual)).toEqual({ claimed: false, reason: "just_ran" });
  clock.value += 5 * 60_000;
  manual.slot = clock.value;
  expect(lease.claimFromPeer(A, manual).claimed).toBe(true);
  expect(JSON.parse(meta.get("orchestrator_claims") ?? "{}").claims[0]).toMatchObject({ slot: manual.slot });
  events.push({ id: "remove", ts: nextDue + 1, json: JSON.stringify({ body: {
    text: `walkie-talkie-schedule:v1:${JSON.stringify({ op: "remove", term: 0, id })}` } }) });
  lease.grant(A);
  expect(JSON.parse(meta.get("orchestrator_claims") ?? "{}").claims[0]).toMatchObject({ slot: manual.slot });
});

test("a failed durable claim write never acknowledges a run", () => {
  const due = Math.floor(Date.now() / 300_000) * 300_000 - 300_000;
  const id = "11111111-1111-4111-8111-111111111111";
  const meta = new Map<string, string>();
  const schedule = { id, name: "Check", cron: "*/5 * * * *", task: { prompt: "Check" }, enabled: true,
    created_by: "alex", last_run: null, next_run: due, last_result: null, failures: 0, run_id: null };
  const core = {
    nodeId: A, authority: A, authorityLeaseTerm: 0, isAuthority: () => true,
    authorityTransferWatermark: null,
    authorityClaimTerms: [{ authority: A, after: null, floor: 0, ceiling: null }],
    roster: { nodes: new Map([[A, { node_id: A, login: "alex" }]]), members: new Map([["alex", { role: "owner", handle: "alex" }]]) },
    store: { claimIndexReady: true, getMeta: (key: string) => meta.get(key) ?? null, setMeta: (key: string, value: string) => { meta.set(key, value); },
      transaction: () => { throw new Error("disk unavailable"); }, channelEventCount: () => 1,
      scheduleClaimEvents: () => [],
      queryEvents: () => [{ id: "schedule", origin: A, seq: 1, ts: due, json: JSON.stringify({ author: { handle: "alex" }, body: {
        text: `walkie-talkie-schedule:v1:${JSON.stringify({ op: "put", term: 0, schedule })}` } }) }] },
  } as unknown as Core;
  const lease = new Leadership({ core, preferred: () => A, lost: () => {} });
  const epoch = lease.grant(A).epoch;
  expect(() => lease.claimFromPeer(A, { schedule: id, slot: due,
    run: "22222222-2222-4222-8222-222222222222", epoch })).toThrow("disk unavailable");
  expect(meta.has("orchestrator_claims")).toBe(false);
});

test("the holder rejects a reply received after its send-time deadline", () => {
  const holder = new LeaseHolder({ self: A, now: () => 0, lost: () => {} });
  const sentWall = Date.now() - 31_000;
  expect(holder.accept({ authority: A, holder: A, epoch: 1, granted: true, ttl_ms: 30000,
    expires_at: Date.now() + 1000 }, 0, A, sentWall)).toBe(false);
});
