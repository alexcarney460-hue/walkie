import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../src/daemon/seats/admin-ledger.ts";
import { CleanupQueue } from "../../src/daemon/seats/cleanup-queue.ts";
import { SeatsHost } from "../../src/daemon/seats/host.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function seed(path: string, count = 1): void {
  const ledger = new Ledger(path);
  const op = { pid: process.pid, start: "seed" };
  for (let n = 1; n <= count; n++) {
    expect(ledger.reserve(n, 501, op).ok).toBe(true);
    expect(ledger.advance(n, op, "reserved", "making")).toBe(true);
    ledger.finish(n, op, "created");
  }
  ledger.close();
}

function hostFor(path: string, adminOp: (verb: string, n: number) => Promise<unknown>, destroyed: number[], waitMs = 100): Record<string, unknown> {
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  Object.assign(host, {
    opts: { reconcileCloseWaitMs: waitMs }, adminOp, closing: false, closed: false,
    seats: new Map(), seatStatuses: { clearPending: () => undefined, stop: () => undefined },
    stopAll: async () => undefined, reaping: new Set(), api: { stop: () => undefined }, socketDir: null,
    log: { warn: () => undefined }, reconcileTimer: null, busyTimer: null, publishTimer: null,
    busyReapply: null, reconcileRetry: null, helperReconciled: Promise.resolve(), listingHelper: false,
    reconciled: false, reconcileError: null, liveUsers: new Set<number>(), userHigh: 0,
    quarantine: new Set<string>(), quarantineFileOnly: new Set<string>(), quarantineWhy: new Map(),
    save: () => true,
  });
  host.cleanup = new CleanupQueue(async (n) => {
    destroyed.push(n);
    await Bun.sleep(2); // Keep the fake attempt open while the test joins pending recovery.
    const ledger = new Ledger(path);
    const op = { pid: process.pid, start: "cleanup" };
    try {
      expect(ledger.takeForDestroy(n, 501, op).ok).toBe(true);
      ledger.finish(n, op, "destroyed");
    } finally { ledger.close(); }
    return { ok: true };
  });
  return host;
}

test("late pending list during close stays in helper ledger for the next start", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".reconcile-close-"));
  dirs.push(dir);
  const path = join(dir, "ids.sqlite");
  seed(path);
  let answer!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => { answer = resolve; });
  const first: number[] = [];
  const closingHost = hostFor(path, async () => pending, first);
  (closingHost.startReconcile as () => void).call(closingHost);
  const closing = (closingHost.close as () => Promise<void>).call(closingHost);
  let closed = false;
  void closing.then(() => { closed = true; });
  await Bun.sleep(1);
  expect(closed).toBe(false);
  answer({ ok: true, ids: [1], idleIds: [1] });
  await closing;
  expect(first).toEqual([]);
  const held = new Ledger(path);
  expect(held.pending(501)).toEqual([1]);
  held.close();

  const second: number[] = [];
  const restarted = hostFor(path, async (verb) => {
    if (verb === "pending") {
      const ledger = new Ledger(path);
      try { return { ok: true, ids: ledger.pending(501) }; } finally { ledger.close(); }
    }
    return { ok: true };
  }, second);
  await (restarted.reconcileHelper as () => Promise<void>).call(restarted);
  await (restarted.cleanup as CleanupQueue<{ ok: boolean }>).close();
  expect(second).toEqual([1]);
  const done = new Ledger(path);
  expect(done.pending(501)).toEqual([]);
  done.close();
});

test("one shutdown bound defers backlog and two live destroys for restart", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".shutdown-bound-"));
  dirs.push(dir);
  const path = join(dir, "ids.sqlite");
  seed(path, 3);
  const destroyed: number[] = [];
  const host = hostFor(path, async () => ({ ok: true }), destroyed);
  host.opts = { shutdownWaitMs: 30, reconcileCloseWaitMs: 10 };
  const started: number[] = [];
  let finishInFlight!: (value: { ok: boolean }) => void;
  const heldAttempt = new Promise<{ ok: boolean }>((resolve) => { finishInFlight = resolve; });
  host.cleanup = new CleanupQueue(async (n) => {
    started.push(n);
    return heldAttempt;
  });
  const cleanup = host.cleanup as CleanupQueue<{ ok: boolean }>;
  const first = cleanup.background(1);
  host.stopAll = async () => { await Promise.all([cleanup.request(2), cleanup.request(3)]); };
  const began = Date.now();
  await (host.close as () => Promise<void>).call(host);
  expect(Date.now() - began).toBeLessThan(200);
  expect(started).toEqual([1]);
  finishInFlight({ ok: false });
  expect((await first).ok).toBe(false);
  await cleanup.close();
  expect(started).toEqual([1]);
  const held = new Ledger(path);
  expect(held.pending(501)).toEqual([1, 2, 3]);
  held.close();

  const restarted = hostFor(path, async (verb) => {
    const ledger = new Ledger(path);
    try { return verb === "pending" ? { ok: true, ids: ledger.pending(501) } : { ok: true }; }
    finally { ledger.close(); }
  }, destroyed);
  await (restarted.reconcileHelper as () => Promise<void>).call(restarted);
  expect([...(restarted.liveUsers as Set<number>)]).toEqual([1, 2, 3]);
  await Promise.all([1, 2, 3].map((n) => (restarted.cleanup as CleanupQueue<{ ok: boolean }>).request(n)));
  await (restarted.cleanup as CleanupQueue<{ ok: boolean }>).close();
  expect(destroyed).toEqual([1, 2, 3]);
  const done = new Ledger(path);
  expect(done.pending(501)).toEqual([]);
  done.close();
});

test("a queued live destroy keeps its waiting reason in the final state", () => {
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  const state = (host.finalState as (seat: unknown, code: number | null, stderr: string) => { state: string; reason?: string })
    .call(host, { run: { runtime: "claude" }, refusal: null, uncontrolled: true, waitedForCleanup: true, cleanupFailure: "seat cleanup deferred until restart" }, null, "");
  expect(state.reason).toContain("waiting for the cleanup of an earlier seat user");
});

test("a queued destroy that later fails reports its actual file failure", async () => {
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  Object.assign(host, { log: { info: () => undefined }, destroyUser: async () => ({ ok: false, why: "files it owns remain or couldn't be checked" }) });
  const seat = { id: "seat", run: { runtime: "claude" }, refusal: null, uncontrolled: false, waitedForCleanup: true, cleanupFailure: null,
    runner: { runtimePid: 123, close: async () => undefined }, child: null, userN: 1,
    paused: false, abort: new AbortController(), stop: null, done: Promise.resolve() };
  await (host.stopSeat as (seat: unknown, stop: unknown) => Promise<void>).call(host, seat, { reason: "stopped" });
  const state = (host.finalState as (seat: unknown, code: number | null, stderr: string) => { state: string; reason?: string })
    .call(host, seat, null, "");
  expect(state.reason).toContain("files it owns remain");
  expect(state.reason).not.toContain("waiting for the cleanup of an earlier seat user");
});


test("close has a bound when pending never answers; a later answer cannot enqueue", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".reconcile-bound-"));
  dirs.push(dir);
  const path = join(dir, "ids.sqlite");
  seed(path);
  let answer!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => { answer = resolve; });
  const destroyed: number[] = [];
  const host = hostFor(path, async () => pending, destroyed, 10);
  (host.startReconcile as () => void).call(host);
  await (host.close as () => Promise<void>).call(host);
  answer({ ok: true, ids: [1] });
  await (host.helperReconciled as Promise<void>);
  expect(destroyed).toEqual([]);
  const ledger = new Ledger(path);
  expect(ledger.pending(501)).toEqual([1]);
  ledger.close();
});
