import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG } from "../../src/pool/catalog.ts";
import { cachePath, DAY_MS, FAILURE_BACKOFF_MS, ModelSource, REFRESH_GAP_MS, STALE_MS } from "../../src/pool/hf/source.ts";
import { fakeHub } from "../helpers/hf-fixtures.ts";

const T0 = Date.parse("2026-10-01T22:00:00Z");
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "walkie-hf-races-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const cached = (file: object): void => {
  mkdirSync(join(home, "pool"), { recursive: true });
  writeFileSync(cachePath(home), JSON.stringify({ v: 1, ...file }));
};
const failingHub = () => {
  const hub = fakeHub();
  hub.inject("huggingface.co", () => { throw new TypeError("fixture offline"); }, 10_000);
  return hub;
};

for (const seeded of [false, true]) {
  test(`a late failed source preserves another source's success (seeded=${seeded})`, async () => {
    if (seeded) cached({ fetched_at: T0 - 2 * DAY_MS, catalog: CATALOG });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bad = fakeHub();
    bad.inject("huggingface.co", async () => { await gate; throw new TypeError("fixture offline"); }, 100);
    const slow = new ModelSource({ home, fetch: bad.fetch, now: () => T0 });
    const pending = slow.load();
    try {
      const good = fakeHub();
      // Without the refresh lock (this source cannot see it): the cache must still keep the winner when a late failure lands.
      const winner = await new ModelSource({ home, fetch: good.fetch, now: () => T0, lock: false }).load();
      const saved = readFileSync(cachePath(home), "utf8");
      release();
      const late = await pending;
      expect(late).toEqual(winner);
      expect(readFileSync(cachePath(home), "utf8")).toBe(saved);
      expect(slow.peek()).toEqual(winner);
      expect(good.calls.length).toBeLessThanOrEqual(450);
    } finally { release(); await pending; }
  });
}

for (const refresh of [false, true]) {
  test(`future success and failure cannot stall refresh (manual=${refresh})`, async () => {
    cached({ fetched_at: T0 + 100 * DAY_MS, catalog: CATALOG,
      failed: { at: T0 + 200 * DAY_MS, kind: "offline", message: "fixture offline" } });
    const hub = fakeHub();
    const source = new ModelSource({ home, fetch: hub.fetch, now: () => T0 });
    expect((await source.load({ offline: true })).state).toBe("built-in");
    expect(hub.calls.length).toBe(0);
    expect((await source.load({ refresh })).checkedAt).toBe(T0);
    expect(hub.calls.length).toBeGreaterThan(0);
    expect(hub.calls.length).toBeLessThanOrEqual(450);
  });
}

test("future failure does not mask a legitimate recent manual-refresh gap", async () => {
  cached({ fetched_at: T0 - 1000, catalog: CATALOG,
    failed: { at: T0 + DAY_MS, kind: "offline", message: "fixture offline" } });
  const hub = fakeHub();
  const source = new ModelSource({ home, fetch: hub.fetch, now: () => T0 });
  expect((await source.load({ refresh: true })).checkedAt).toBe(T0 - 1000);
  expect(hub.calls.length).toBe(0);
});

test("clock rollback retries once and subsequent failures keep the normal backoff", async () => {
  let now = T0;
  const hub = failingHub();
  const source = new ModelSource({ home, fetch: hub.fetch, now: () => now });
  await source.load();
  const first = hub.calls.length;
  now -= DAY_MS;
  expect((await source.load()).note).toContain("no network");
  expect(hub.calls.length).toBeGreaterThan(first);
  const second = hub.calls.length;
  now += FAILURE_BACKOFF_MS - 1;
  expect((await source.load()).note).toContain("1 minute");
  expect(hub.calls.length).toBe(second);
  now += 1;
  await source.load();
  expect(hub.calls.length).toBeGreaterThan(second);
});

for (const obstruction of ["parent-file", "cache-directory", "unwritable"] as const) {
  test(`cache ${obstruction} returns a diagnostic fallback and bounds retries`, async () => {
    const pool = join(home, "pool");
    if (obstruction === "parent-file") writeFileSync(pool, "fixture obstruction");
    else mkdirSync(pool);
    if (obstruction === "cache-directory") mkdirSync(cachePath(home));
    if (obstruction === "unwritable") chmodSync(pool, 0o500);
    const events: string[] = [];
    const hub = failingHub();
    let now = T0;
    const source = new ModelSource({ home, fetch: hub.fetch, now: () => now, log: (event) => events.push(event) });
    try {
      expect((await source.load()).note).toContain("no network");
      expect(events).toContain("pool_models_cache_failed");
      const count = hub.calls.length;
      expect((await source.load({ offline: true })).note).toContain("no network");
      now += REFRESH_GAP_MS - 1;
      await source.load({ refresh: true });
      expect(hub.calls.length).toBe(count);
      now = T0 + FAILURE_BACKOFF_MS;
      await source.load();
      expect(hub.calls.length).toBeGreaterThan(count);
    } finally { if (obstruction === "unwritable") chmodSync(pool, 0o700); }
  });
}

test("a successful fetch remains available when the cache parent is obstructed", async () => {
  writeFileSync(join(home, "pool"), "fixture obstruction");
  const hub = fakeHub();
  const events: string[] = [];
  const source = new ModelSource({ home, fetch: hub.fetch, now: () => T0, log: (event) => events.push(event) });
  const view = await source.load();
  expect(view.state).toBe("fresh");
  expect(view.catalog.models.length).toBe(16);
  expect(events).toEqual(["pool_models_cache_failed", "pool_models_refresh_ok"]);
  const count = hub.calls.length;
  expect(await source.load({ offline: true })).toEqual(view);
  expect(await source.load()).toEqual(view);
  expect(hub.calls.length).toBe(count);
});

for (const age of [DAY_MS - 1, DAY_MS, STALE_MS, STALE_MS + 1]) {
  test(`offline freshness boundary at age ${age}`, async () => {
    cached({ fetched_at: T0 - age, catalog: CATALOG });
    const hub = fakeHub();
    const source = new ModelSource({ home, fetch: hub.fetch, now: () => T0 });
    const view = await source.load({ offline: true });
    expect(view.state).toBe(age < DAY_MS ? "fresh" : age <= STALE_MS ? "stale" : "built-in");
    expect(hub.calls.length).toBe(0);
  });
}

for (const field of ["fetched_at", "failed"] as const) {
  test(`a future ${field} alone permits refresh after a failed attempt`, async () => {
    cached(field === "fetched_at"
      ? { fetched_at: T0 + DAY_MS, catalog: CATALOG }
      : { failed: { at: T0 + DAY_MS, kind: "offline", message: "fixture offline" } });
    let now = T0;
    const hub = failingHub();
    const source = new ModelSource({ home, fetch: hub.fetch, now: () => now });
    expect((await source.load()).note).toContain("no network");
    const count = hub.calls.length;
    expect(count).toBeGreaterThan(0);
    now += FAILURE_BACKOFF_MS;
    await source.load();
    expect(hub.calls.length).toBeGreaterThan(count);
  });
}

test("an unwritable stale cache retains its catalog and backs off in memory", async () => {
  cached({ fetched_at: T0 - 2 * DAY_MS, catalog: CATALOG });
  const pool = join(home, "pool");
  const original = readFileSync(cachePath(home), "utf8");
  chmodSync(pool, 0o500);
  const hub = failingHub();
  const source = new ModelSource({ home, fetch: hub.fetch, now: () => T0 });
  try {
    expect(await source.load()).toMatchObject({ state: "stale", checkedAt: T0 - 2 * DAY_MS });
    const count = hub.calls.length;
    expect((await source.load()).note).toContain("15 minutes");
    expect(hub.calls.length).toBe(count);
    expect(readFileSync(cachePath(home), "utf8")).toBe(original);
  } finally { chmodSync(pool, 0o700); }
});


test("a late 429 preserves a success from a later refresh window", async () => {
  cached({ fetched_at: T0 - 2 * DAY_MS, catalog: CATALOG });
  let now = T0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const limited = fakeHub();
  limited.inject("huggingface.co", async () => { await gate; return new Response("fixture limited", { status: 429 }); }, 100);
  const slow = new ModelSource({ home, fetch: limited.fetch, now: () => now });
  const pending = slow.load();
  try {
    now += 1000;
    const winner = await new ModelSource({ home, fetch: fakeHub().fetch, now: () => now, lock: false }).load();
    const saved = readFileSync(cachePath(home), "utf8");
    expect(winner.checkedAt).toBe(T0 + 1000);
    release();
    expect(await pending).toEqual(winner);
    expect(readFileSync(cachePath(home), "utf8")).toBe(saved);
    expect(await slow.load({ offline: true })).toEqual(winner);
  } finally { release(); await pending; }
});

test("rollback during a failed refresh starts backoff at completion", async () => {
  let now = T0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const hub = fakeHub();
  hub.inject("huggingface.co", async () => { await gate; throw new TypeError("fixture offline"); }, 100);
  const source = new ModelSource({ home, fetch: hub.fetch, now: () => now });
  const pending = source.load();
  now -= DAY_MS;
  release();
  expect((await pending).note).toContain("no network");
  expect(JSON.parse(readFileSync(cachePath(home), "utf8")).failed.at).toBe(now);
  const count = hub.calls.length;
  now += FAILURE_BACKOFF_MS - 1;
  expect((await source.load()).note).toContain("1 minute");
  expect(hub.calls.length).toBe(count);
  now += 1;
  await source.load();
  expect(hub.calls.length).toBeGreaterThan(count);
});
