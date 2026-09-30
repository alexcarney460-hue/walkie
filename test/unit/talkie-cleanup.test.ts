import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CleanupObligation, cleanupDelay } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";
import { processStart, selfOp } from "../../src/daemon/seats/admin-ledger.ts";
import { HttpError } from "../../src/daemon/http.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync("/tmp/walkie-cleanup-"); roots.push(path); return path; };

test("one 0600 obligation survives a new reader and clears only for its generation", () => {
  const path = join(root(), "cleanup.sqlite");
  const first = new CleanupObligation(path);
  expect(first.record("run-one")).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(new CleanupObligation(path).read()?.generation).toBe("run-one");
  expect(first.record("run-two")).toBe(false);
  first.failure("run-one", "helper failed");
  expect(first.read()?.attempts).toBe(1);
  expect(first.clear("run-two")).toBe(false);
  expect(first.clear("run-one")).toBe(true);
  expect(new CleanupObligation(path).read()).toBeNull();
  expect(new CleanupObligation(path).record("run-one")).toBe(false);
  expect(new CleanupObligation(path).record("run-two")).toBe(true);
  expect(new CleanupObligation(path).read()?.generation).toBe("run-two");
});

test("fast cleanup backoff becomes a jittered five minute retry", () => {
  expect([1, 2, 8, 9, 12].map((n) => cleanupDelay(n, 0.5))).toEqual([250, 500, 30_000, 30_000, 300_000]);
  expect(cleanupDelay(13, 0)).toBe(270_000);
  expect(cleanupDelay(13, 1)).toBe(330_000);
});

test("future owner heartbeat cannot block monitor takeover", () => {
  const path = join(root(), "cleanup.sqlite");
  const ledger = new CleanupObligation(path);
  expect(ledger.record("run", selfOp(), 3_000)).toBe(true);
  const db = new Database(path);
  try { db.query("UPDATE retry_owner SET heartbeat = ? WHERE generation = ?").run(Date.now() + 30_000, "run"); }
  finally { db.close(); }
  expect(ledger.ownerActive("run")).toBe(false);
  expect(ledger.record("run", { pid: process.pid + 1, start: "other" }, 3_000)).toBe(true);
});

test("daemon renews a short owner lease while helper destroy is in flight", async () => {
  const dir = root();
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  const cleanupFile = join(dir, "cleanup.sqlite");
  let finish: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile,
    admin: async (verb) => {
      if (verb === "talkie-destroy") { await blocked; return { ok: true }; }
      return { ok: true, name: "walkie-talkie", uid: 550_000, home };
    },
  });
  await user.prepare();
  const destroy = user.destroy();
  try {
    const row = () => { const db = new Database(cleanupFile); try { return db.query("SELECT heartbeat, interval_ms FROM retry_owner").get() as { heartbeat: number; interval_ms: number }; } finally { db.close(); } };
    const first = row();
    expect(first.interval_ms).toBeLessThanOrEqual(4_000);
    await Bun.sleep(2_200);
    expect(row().heartbeat).toBeGreaterThan(first.heartbeat);
  } finally { finish(); await destroy; }
});

test("rejected preparation cleanup reports the pending obligation", async () => {
  const path = join(root(), "cleanup.sqlite");
  expect(new CleanupObligation(path).record("pending-run")).toBe(true);
  const user = new TalkieOsUser("/not-a-socket", () => false, { cleanupFile: path });
  Object.assign(user, { cleaning: Promise.reject(new Error("helper cleanup failed")) });
  try {
    await user.prepare();
    throw new Error("prepare unexpectedly succeeded");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).code).toBe("talkie_cleanup_pending");
  }
});

test("failed destroy records before helper call, retries, blocks reuse, and resumes after restart", async () => {
  const dir = root();
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  const path = join(dir, "cleanup.sqlite");
  const ledger = new CleanupObligation(path);
  let fail = true;
  let attempts = 0;
  const deps = {
    ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile: path,
    admin: async (verb: string, generation?: string) => {
      if (verb === "talkie-destroy") {
        attempts++;
        expect(ledger.read()?.generation).toBe(generation);
        return fail ? { ok: false, why: "helper unavailable" } : { ok: true };
      }
      return { ok: true, name: "walkie-talkie", uid: 550_000, home };
    },
    retrySleep: async () => { await Bun.sleep(1); },
  };
  const user = new TalkieOsUser("/not-a-socket", () => false, deps);
  await user.prepare();
  await expect(user.destroy()).rejects.toThrow("not verified");
  expect(ledger.read()?.attempts).toBeGreaterThanOrEqual(1);
  await expect(user.prepare()).rejects.toThrow("cleanup pending");
  const restarted = new TalkieOsUser("/not-a-socket", () => false, deps);
  await restarted.cleanupStale();
  fail = false;
  for (let i = 0; i < 100 && ledger.read(); i++) await Bun.sleep(2);
  expect(attempts).toBeGreaterThan(1);
  expect(ledger.read()).toBeNull();
});

test("unwritable obligation still destroys now and retries until storage returns", async () => {
  const dir = root();
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  const path = join(dir, "cleanup.sqlite");
  let destroys = 0;
  const waits: Array<() => void> = [];
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile: path,
    admin: async (verb) => verb === "talkie-destroy"
      ? (++destroys < 3 ? { ok: false, why: "helper unavailable" } : { ok: true })
      : { ok: true, name: "walkie-talkie", uid: 550_000, home },
    retrySleep: () => new Promise((resolve) => { waits.push(resolve); }),
  });
  await user.prepare();
  rmSync(path);
  mkdirSync(path);
  await expect(user.destroy()).rejects.toThrow("not verified");
  expect(destroys).toBe(1);
  expect(user.pendingCleanup?.diagnostic).toContain("could not record");
  waits.shift()?.();
  for (let i = 0; i < 50 && destroys < 2; i++) await Bun.sleep(2);
  expect(destroys).toBe(2);
  rmSync(path, { recursive: true });
  for (let i = 0; i < 50 && !waits.length; i++) await Bun.sleep(2);
  waits.shift()?.();
  for (let i = 0; i < 50 && destroys < 3; i++) await Bun.sleep(2);
  expect(destroys).toBe(3);
  expect(new CleanupObligation(path).read()).toBeNull();
  expect(user.pendingCleanup).toBeNull();
});

test("a live monitor owns immediate retries while the daemon arms a watchdog", async () => {
  const dir = root();
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  const cleanupFile = join(dir, "cleanup.sqlite");
  let calls = 0, killed = false, retries = 0, run = "";
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile,
    admin: async (verb) => verb === "talkie-destroy" ? (++calls, { ok: false, why: "helper unavailable" })
      : { ok: true, name: "walkie-talkie", uid: 550_000, home },
    monitor: (_file, generation) => { run = generation; return { kill: () => { killed = true; }, exited: new Promise(() => {}) }; },
    retrySleep: () => { retries++; return new Promise(() => {}); },
  });
  await user.prepare();
  await expect(user.destroy()).rejects.toThrow("not verified");
  expect(new CleanupObligation(cleanupFile).monitorOwner(run)).toBeNull();
  await expect(user.destroy()).rejects.toThrow("not verified");
  await Bun.sleep(5);
  expect(calls).toBe(1);
  expect(retries).toBe(1);
  expect(killed).toBe(false);
});

test("verified person repair stops and reaps the live monitor handle", async () => {
  const dir = root();
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  const cleanupFile = join(dir, "cleanup.sqlite");
  let killed = false;
  let exit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile,
    admin: async (verb) => verb === "talkie-destroy" ? { ok: false, why: "helper uninstalled" }
      : { ok: true, name: "walkie-talkie", uid: 550_000, home },
    monitor: () => ({ kill: () => { killed = true; exit(0); }, exited }),
  });
  await user.prepare();
  await expect(user.destroy()).rejects.toThrow("not verified");
  const obligation = new CleanupObligation(cleanupFile);
  expect(obligation.clear(obligation.read()!.generation)).toBe(true);
  await user.finishRepairedCleanup();
  expect(killed).toBe(true);
  expect(user.pendingCleanup).toBeNull();
});

test("a restarted daemon watches the recorded live monitor without retrying its generation", async () => {
  const dir = root();
  const cleanupFile = join(dir, "cleanup.sqlite");
  const obligation = new CleanupObligation(cleanupFile);
  const start = processStart(1);
  expect(start).not.toBeNull();
  expect(obligation.record("run", { pid: 1, start: start! })).toBe(true);
  let calls = 0, sleeps = 0;
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    cleanupFile, admin: async () => { calls++; return { ok: false }; },
    retrySleep: () => ++sleeps === 1 ? Promise.resolve() : new Promise(() => {}),
  });
  await user.cleanupStale();
  await Bun.sleep(10);
  expect(calls).toBe(0);
  expect(sleeps).toBe(2);
});

test("a restarted daemon takes over when the recorded monitor has exited", async () => {
  const dir = root();
  const cleanupFile = join(dir, "cleanup.sqlite");
  const obligation = new CleanupObligation(cleanupFile);
  const gone = Bun.spawnSync(["/bin/sh", "-c", "exit 0"]);
  expect(obligation.record("run", { pid: gone.pid, start: "gone" })).toBe(true);
  let calls = 0;
  let wake: () => void = () => { throw new Error("retry was not armed"); };
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    cleanupFile, admin: async () => { calls++; return { ok: true }; },
    retrySleep: () => new Promise<void>((resolve) => { wake = resolve; }),
  });
  await user.cleanupStale();
  wake();
  for (let i = 0; i < 50 && obligation.read(); i++) await Bun.sleep(2);
  expect(calls).toBe(1);
  expect(obligation.read()).toBeNull();
});

test("a stale owner heartbeat permits takeover even when its process still exists", () => {
  const path = join(root(), "cleanup.sqlite");
  const obligation = new CleanupObligation(path);
  const owner = selfOp();
  expect(obligation.record("run", owner, 1_000)).toBe(true);
  const db = new Database(path);
  try { db.query("UPDATE retry_owner SET heartbeat = ? WHERE generation = ?").run(Date.now() - 3_001, "run"); }
  finally { db.close(); }
  expect(obligation.ownerActive("run")).toBe(false);
});

test("a daemon destroy cannot pass a live monitor's atomic owner claim", async () => {
  const dir = root();
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  const cleanupFile = join(dir, "cleanup.sqlite");
  let run = "", calls = 0;
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile,
    admin: async (verb) => verb === "talkie-destroy" ? (++calls, { ok: false, why: "busy" })
      : { ok: true, name: "walkie-talkie", uid: 550_000, home },
    monitor: (_file, generation) => { run = generation; return { kill: () => undefined, exited: new Promise(() => {}) }; },
  });
  await user.prepare();
  const start = processStart(1);
  expect(start).not.toBeNull();
  const obligation = new CleanupObligation(cleanupFile);
  expect(obligation.record(run, { pid: 1, start: start! })).toBe(true);
  expect(obligation.record(run)).toBe(false);
  await expect(user.destroy()).rejects.toThrow("not verified");
  expect(calls).toBe(0);
});

test("a monitor that exits after cleanup handoff is restarted", async () => {
  const dir = root();
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  const monitors: Array<(code: number) => void> = [];
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir,
    admin: async (verb) => verb === "talkie-destroy" ? { ok: false, why: "helper unavailable" }
      : { ok: true, name: "walkie-talkie", uid: 550_000, home },
    monitor: () => {
      let exit: (code: number) => void = () => undefined;
      const exited = new Promise<number>((resolve) => { exit = resolve; });
      monitors.push(exit);
      return { exited, kill: () => exit(0) };
    },
  });
  await user.prepare();
  await expect(user.destroy()).rejects.toThrow("not verified");
  monitors[0]!(1);
  await Bun.sleep(0);
  expect(monitors).toHaveLength(2);
});
