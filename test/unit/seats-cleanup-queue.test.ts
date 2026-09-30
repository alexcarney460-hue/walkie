import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../src/daemon/seats/admin-ledger.ts";
import { CleanupQueue } from "../../src/daemon/seats/cleanup-queue.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("57 slow destroys use one helper, retire the real ledger, and drain oldest first", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".cleanup-queue-"));
  dirs.push(dir);
  const ledger = new Ledger(join(dir, "ids.sqlite"));
  const op = { pid: process.pid, start: "create" };
  for (let n = 1; n <= 57; n++) {
    expect(ledger.reserve(n, 501, op).ok).toBe(true);
    expect(ledger.advance(n, op, "reserved", "making")).toBe(true);
    ledger.finish(n, op, "created");
  }
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  const queue = new CleanupQueue(async (n) => {
    active++;
    peak = Math.max(peak, active);
    order.push(n);
    const claim = ledger.takeForDestroy(n, 501, { pid: process.pid, start: `destroy-${n}` });
    expect(claim.ok).toBe(true);
    await Bun.sleep(2);
    ledger.finish(n, { pid: process.pid, start: `destroy-${n}` }, "destroyed");
    active--;
    return { ok: true };
  }, { retryBaseMs: 5 });
  const results = await Promise.all(Array.from({ length: 57 }, (_, i) => queue.request(i + 1)));
  expect(results.every((r) => r.ok)).toBe(true);
  expect(peak).toBe(1);
  expect(order).toEqual(Array.from({ length: 57 }, (_, i) => i + 1));
  expect(ledger.pending(501)).toEqual([]);
  await queue.close();
  ledger.close();
});

test("failed users retry with per-user exponential backoff and shutdown cancels retries", async () => {
  const attempts: number[] = [];
  const queue = new CleanupQueue(async (n) => {
    attempts.push(n);
    return { ok: attempts.filter((x) => x === n).length >= 3 };
  }, { retryBaseMs: 10, retryMaxMs: 40 });
  expect((await queue.request(2)).ok).toBe(false);
  expect(queue.retryDelay(2)).toBe(10);
  await Bun.sleep(15);
  expect(attempts).toEqual([2, 2]);
  expect(queue.retryDelay(2)).toBe(20);
  await queue.close();
  await Bun.sleep(30);
  expect(attempts).toEqual([2, 2]);
});

test("due retries do not overtake older first cleanup attempts", async () => {
  const order: number[] = [];
  const queue = new CleanupQueue(async (n) => {
    order.push(n);
    await Bun.sleep(8);
    return { ok: order.filter((x) => x === n).length > 1 };
  }, { retryBaseMs: 1 });
  await Promise.all([1, 2, 3, 4].map((n) => queue.request(n)));
  expect(order.slice(0, 4)).toEqual([1, 2, 3, 4]);
  await queue.close();
});

test("live cleanup passes background backlog while keeping one helper", async () => {
  const order: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  let peak = 0;
  const queue = new CleanupQueue(async (n) => {
    order.push(n);
    active++;
    peak = Math.max(peak, active);
    if (n === 1) await held;
    active--;
    return { ok: true };
  });
  const backlog = Array.from({ length: 10 }, (_, i) => queue.background(i + 1));
  const live = queue.request(100);
  release();
  expect((await live).ok).toBe(true);
  expect(order.slice(0, 2)).toEqual([1, 100]);
  expect(peak).toBe(1);
  await Promise.all(backlog);
  await queue.close();
});

test("close defers queued work and only awaits the in-flight attempt", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started: number[] = [];
  const queue = new CleanupQueue(async (n) => {
    started.push(n);
    if (n === 1) await held;
    return { ok: true };
  });
  const requests = Array.from({ length: 10 }, (_, i) => queue.background(i + 1));
  const closing = queue.close();
  release();
  await closing;
  const results = await Promise.all(requests);
  expect(started).toEqual([1]);
  expect(results[0]?.ok).toBe(true);
  expect(results.slice(1).every((result) => !result.ok)).toBe(true);
});

test("deferred ledger users are found on the next queue start", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".cleanup-restart-"));
  dirs.push(dir);
  const ledger = new Ledger(join(dir, "ids.sqlite"));
  const create = { pid: process.pid, start: "create" };
  for (let n = 1; n <= 10; n++) {
    ledger.reserve(n, 501, create);
    ledger.advance(n, create, "reserved", "making");
    ledger.finish(n, create, "created");
  }
  const destroy = async (n: number) => {
    const op = { pid: process.pid, start: `destroy-${n}` };
    ledger.takeForDestroy(n, 501, op);
    ledger.finish(n, op, "destroyed");
    return { ok: true };
  };
  const first = new CleanupQueue(destroy);
  const pending = ledger.pending(501).map((n) => first.background(n));
  await first.close();
  await Promise.all(pending);
  expect(ledger.pending(501).length).toBeGreaterThan(0);
  const restarted = new CleanupQueue(destroy);
  await Promise.all(ledger.pending(501).map((n) => restarted.background(n)));
  expect(ledger.pending(501)).toEqual([]);
  await restarted.close();
  ledger.close();
});

test("slow helper keeps the next destroy queued until it finishes", async () => {
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started: number[] = [];
  const queue = new CleanupQueue(async (n) => {
    active++;
    started.push(n);
    peak = Math.max(peak, active);
    if (n === 1) await held;
    active--;
    return { ok: true };
  });
  const first = queue.background(1);
  const second = queue.request(2);
  expect(queue.active?.user).toBe(1);
  expect(queue.waiting(2)).toBe(true);
  await Bun.sleep(25);
  expect(started).toEqual([1]);
  release();
  expect((await first).ok).toBe(true);
  expect((await second).ok).toBe(true);
  expect(peak).toBe(1);
  await queue.close();
});

test("shutdown defers queued first attempts and cancels future retries", async () => {
  const order: number[] = [];
  const queue = new CleanupQueue(async (n) => {
    order.push(n);
    await Bun.sleep(3);
    return { ok: n !== 2 };
  }, { retryBaseMs: 100 });
  const results = [queue.request(1), queue.request(2), queue.request(3)];
  await queue.close();
  expect((await Promise.all(results)).map((r) => r.ok)).toEqual([true, false, false]);
  await Bun.sleep(120);
  expect(order).toEqual([1]);
});
