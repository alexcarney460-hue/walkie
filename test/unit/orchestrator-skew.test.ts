import { expect, test } from "bun:test";
import { LeaseAuthority, LeaseHolder } from "../../src/daemon/orchestrator/lease.ts";
const A = "a".repeat(16), B = "b".repeat(16), C = "c".repeat(16), BASE = 1_800_000_000_000;
for (const skew of [15_000, 30_000]) test(`holder ${skew}ms ahead leads continuously across eight renewals`, () => {
  let real = 0, lost = 0;
  const book = new LeaseAuthority({ load: () => null, save: () => {}, now: () => real, wallNow: () => BASE + real, ttl: 30_000 });
  const b = new LeaseHolder({ self: B, now: () => real, wallNow: () => BASE + real + skew, lost: () => { lost++; } });
  for (real = 0; real < 120_000; real += 250) {
    if (real % 15_000 === 0) expect(b.accept(book.grant(A, B, B), real, A, BASE + real + skew)).toBe(true);
    b.check(A);
    expect(b.valid(A)).toBe(true);
  }
  expect(lost).toBe(0);
});
test("holder six seconds behind expires across sleep before successor starts", () => {
  let real = 0, mono = 0;
  const book = new LeaseAuthority({ load: () => null, save: () => {}, now: () => real, wallNow: () => BASE + real, ttl: 30_000 });
  const b = new LeaseHolder({ self: B, now: () => mono, wallNow: () => BASE + real - 6000, lost: () => {} });
  expect(b.accept(book.grant(A, B, B), mono, A, BASE - 6000)).toBe(true);
  real = 33_000; mono = 1000;
  expect(book.grant(A, C, C).granted).toBe(true);
  expect(b.valid(A)).toBe(false);
});
test("frozen holder clocks cannot extend a grant after they catch up", () => {
  let authorityMono = 0, holderMono = 0, holderWall = BASE - 6000;
  const book = new LeaseAuthority({ load: () => null, save: () => {}, now: () => authorityMono,
    wallNow: () => BASE + authorityMono, ttl: 30_000 });
  const b = new LeaseHolder({ self: B, now: () => holderMono, wallNow: () => holderWall, lost: () => {} });
  expect(b.accept(book.grant(A, B, B), 0, A, holderWall)).toBe(true);
  authorityMono = 33_000;
  expect(book.grant(A, C, C).granted).toBe(true);
  holderWall += 33_000; // Wall clock catches up on resume; monotonic clock remained frozen.
  expect(b.valid(A)).toBe(false);
});
