import { expect, test } from "bun:test";
import { LeaseAuthority, LeaseHolder } from "../../src/daemon/orchestrator/lease.ts";
const A = "a".repeat(16), B = "b".repeat(16);

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

test("the holder rejects a reply received after its send-time deadline", () => {
  const holder = new LeaseHolder({ self: A, now: () => 0, lost: () => {} });
  const sentWall = Date.now() - 31_000;
  expect(holder.accept({ authority: A, holder: A, epoch: 1, granted: true, ttl_ms: 30000,
    expires_at: Date.now() + 1000 }, 0, A, sentWall)).toBe(false);
});
