// ROUND 5 (Opus round-4 MED): destroying the shell user ends its uid monitor and reaps it, but the wait is bounded: a
// monitor that does not exit (stuck in the kernel, or ignoring the signal) must not hold a Stop.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

async function shellUser(monitor: () => { kill: () => void; exited?: Promise<number | null> }) {
  const dir = mkdtempSync("/tmp/walkie-monexit-"); roots.push(dir);
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile: join(dir, "cleanup.sqlite"),
    admin: async (verb) => verb === "talkie-destroy" ? { ok: true } : { ok: true, name: "walkie-talkie", uid: 550_000, home },
    monitor,
  });
  await user.prepare();
  return user;
}

test("destroy waits for the ended monitor to exit", async () => {
  let killed = false;
  const user = await shellUser(() => ({
    kill: () => { killed = true; },
    exited: new Promise<number | null>((resolve) => { const t = setInterval(() => { if (killed) { clearInterval(t); setTimeout(() => resolve(null), 300); } }, 10); }),
  }));
  const started = Date.now();
  await user.destroy();
  expect(killed).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
});

test("destroy stops waiting for a monitor that never exits", async () => {
  let killed = false;
  const user = await shellUser(() => ({ kill: () => { killed = true; }, exited: new Promise<number | null>(() => undefined) }));
  const started = Date.now();
  await Promise.race([user.destroy(), Bun.sleep(4_000).then(() => { throw new Error("destroy waited for the monitor"); })]);
  expect(killed).toBe(true);
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(user.pendingCleanup).toBeNull();
});

test("a verified repair stops waiting for a monitor that never exits", async () => {
  const dir = mkdtempSync("/tmp/walkie-monexit-"); roots.push(dir);
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  const cleanupFile = join(dir, "cleanup.sqlite");
  let killed = false;
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile,
    admin: async (verb) => verb === "talkie-destroy" ? { ok: false, why: "helper uninstalled" } : { ok: true, name: "walkie-talkie", uid: 550_000, home },
    monitor: () => ({ kill: () => { killed = true; }, exited: new Promise<number | null>(() => undefined) }),
  });
  await user.prepare();
  await expect(user.destroy()).rejects.toThrow("not verified");
  const { CleanupObligation } = await import("../../src/daemon/orchestrator/cleanup-obligation.ts");
  const obligation = new CleanupObligation(cleanupFile);
  expect(obligation.clear(obligation.read()!.generation)).toBe(true);
  const started = Date.now();
  await Promise.race([user.finishRepairedCleanup(), Bun.sleep(4_000).then(() => { throw new Error("repair waited for the monitor"); })]);
  expect(killed).toBe(true);
  expect(Date.now() - started).toBeLessThan(3_000);
});
