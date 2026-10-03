import { expect, test } from "bun:test";
import { superviseReserve } from "../../src/daemon/seats/reserve.ts";
import type { AccountUsage } from "../../src/protocol/accounts.ts";

const fresh = (used: number): AccountUsage => ({ state: "ok", at: Date.now(), source: "api", reason: null, until: null,
  windows: [{ kind: "session", scope: null, window_s: 18000, resets_at: Date.now() + 60000, used_pct: used }] });
async function until(cond: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}
const throttle = () => Object.assign(new Error("usage refresh is throttled"), { status: 429, code: "rate_limited" });

test("a borrowed pool seat stops once at 10%, and its monitor is released", async () => {
  let left = 11;
  let stops = 0;
  const read = (): AccountUsage => ({ state: "ok", at: Date.now(), source: "api", reason: null, until: null,
    windows: [{ kind: "session", scope: null, window_s: 18000, resets_at: Date.now() + 60000, used_pct: 100 - left }] });
  const cancel = superviseReserve({ read, refresh: async () => null, stop: async () => { stops++; }, error: () => {}, everyMs: 5 });
  try {
    await Bun.sleep(20); expect(stops).toBe(0);
    left = 10;
    await Bun.sleep(20); expect(stops).toBe(1);
    await Bun.sleep(20); expect(stops).toBe(1);
  } finally { cancel(); }
});

test("ending a seat cancels its reserve checks", async () => {
  let reads = 0;
  const cancel = superviseReserve({ read: () => { reads++; return null; }, refresh: async () => null, stop: async () => {}, error: () => {}, everyMs: 5 });
  cancel();
  await Bun.sleep(20);
  expect(reads).toBe(0);
});

test("unknown usage retries stopping the borrowed seat when refresh and the first stop fail", async () => {
  let stops = 0, errors = 0;
  const cancel = superviseReserve({ read: () => null, refresh: async () => { throw new Error("current account grant is required"); },
    stop: async () => { stops++; if (stops === 1) throw new Error("cleanup failed"); },
    error: () => { errors++; }, everyMs: 5 });
  try {
    await until(() => stops >= 2, "the second stop");
    await Bun.sleep(20);
    expect(stops).toBe(2);
    expect(errors).toBeGreaterThan(0);
  } finally { cancel(); }
});

test("one failed reserve check does not stop a borrowed seat; three in a row do, and a fresh reading resets the count", async () => {
  let refreshes = 0, stops = 0, stoppedAt = 0;
  const cancel = superviseReserve({ read: () => null,
    refresh: async () => { refreshes++; if (refreshes === 3) return fresh(50); throw new Error("the lending machine is unreachable"); },
    stop: async () => { stops++; stoppedAt = refreshes; }, error: () => {}, everyMs: 3 });
  try {
    await until(() => refreshes >= 5, "five checks");
    expect(stops).toBe(0); // fail, fail, fresh, fail, fail
    await until(() => stops === 1, "the stop");
    expect(stoppedAt).toBe(6);
  } finally { cancel(); }
});

test("a throttled usage refresh (429 from the lender) is retried, not treated as an unverifiable reserve", async () => {
  let refreshes = 0, stops = 0;
  const cancel = superviseReserve({ read: () => null,
    refresh: async () => { refreshes++; if (refreshes <= 8) throw throttle(); return fresh(50); },
    stop: async () => { stops++; }, error: () => {}, everyMs: 3 });
  try {
    await until(() => refreshes >= 12, "twelve checks");
    expect(stops).toBe(0);
  } finally { cancel(); }
});

test("throttled checks mixed with unknown readings stay within the same bound of 13 checks", async () => {
  // Several borrowed seats on one host share the lender's refresh limit: ten throttled refreshes, then a stale reading,
  // over and over. The throttled checks are not forgotten at each stale reading.
  let refreshes = 0, stops = 0, stoppedAt = 0;
  const stale: AccountUsage = { ...fresh(50), at: Date.now() - 61 * 60_000 };
  const cancel = superviseReserve({ read: () => null,
    refresh: async () => { refreshes++; if (refreshes % 11 === 0) return stale; throw throttle(); },
    stop: async () => { stops++; stoppedAt = refreshes; }, error: () => {}, everyMs: 3 });
  try {
    await until(() => stops === 1, "the stop");
    expect(stoppedAt).toBe(13); // 10 throttled, 1 stale (failed 1), then 2 throttled past the bound (failed 2, 3)
  } finally { cancel(); }
});

test("throttling that never ends still stops the borrowed seat after a bounded number of checks", async () => {
  let refreshes = 0, stops = 0, stoppedAt = 0;
  const cancel = superviseReserve({ read: () => null, refresh: async () => { refreshes++; throw throttle(); },
    stop: async () => { stops++; stoppedAt = refreshes; }, error: () => {}, everyMs: 3 });
  try {
    await until(() => stops === 1, "the stop");
    expect(stoppedAt).toBe(13); // 10 tolerated throttled checks, then 3 failed ones
  } finally { cancel(); }
});

test.each([50, 95])("stale reserve reading (%d%% used) stops when refresh remains stale", async (used) => {
  let stops = 0, refreshes = 0;
  let usage: AccountUsage = { state: "ok", at: Date.now() - 61 * 60_000, source: "api", reason: null, until: null,
    windows: [{ kind: "session", scope: null, window_s: 18000, resets_at: Date.now() + 60000, used_pct: used }] };
  const cancel = superviseReserve({ read: () => usage, refresh: async () => { refreshes++; return usage; },
    stop: async () => { stops++; }, error: () => {}, everyMs: 5 });
  try {
    await until(() => stops === 1, "the stop");
    await Bun.sleep(20);
    expect(refreshes).toBe(3); expect(stops).toBe(1);
  } finally { cancel(); }
});
