import { expect, test } from "bun:test";
import { superviseReserve } from "../../src/daemon/seats/reserve.ts";
import type { AccountUsage } from "../../src/protocol/accounts.ts";

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

test("unknown usage refreshes without stopping and reports a refresh failure", async () => {
  let stops = 0, errors = 0;
  const cancel = superviseReserve({ read: () => null, refresh: async () => { throw new Error("refresh unavailable"); }, stop: async () => { stops++; throw new Error("cleanup failed"); }, error: () => { errors++; }, everyMs: 5 });
  try {
    await Bun.sleep(25);
    expect(stops).toBe(0);
    expect(errors).toBeGreaterThan(0);
  } finally { cancel(); }
});

test.each([50, 95])("stale reserve reading (%d%% used) refreshes; only fresh low usage stops", async (used) => {
  let stops = 0, refreshes = 0;
  let usage: AccountUsage = { state: "ok", at: Date.now() - 61 * 60_000, source: "api", reason: null, until: null,
    windows: [{ kind: "session", scope: null, window_s: 18000, resets_at: Date.now() + 60000, used_pct: used }] };
  const cancel = superviseReserve({ read: () => usage, refresh: async () => { refreshes++; return usage; },
    stop: async () => { stops++; }, error: () => {}, everyMs: 5 });
  try {
    await Bun.sleep(25);
    expect(refreshes).toBeGreaterThan(0); expect(stops).toBe(0);
    usage = { ...usage, at: Date.now(), windows: [{ ...usage.windows[0]!, used_pct: 50 }] };
    await Bun.sleep(20); expect(stops).toBe(0);
    usage = { ...usage, at: Date.now(), windows: [{ ...usage.windows[0]!, used_pct: 90 }] };
    await Bun.sleep(20); expect(stops).toBe(1);
  } finally { cancel(); }
});
