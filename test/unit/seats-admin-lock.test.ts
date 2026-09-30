import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CleanupQueue } from "../../src/daemon/seats/cleanup-queue.ts";
import { SeatAdminBusyError, verifySeatLockParents, withSeatAdminLock } from "../../src/daemon/seats/talkie-lock.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const lockPath = () => {
  const dir = mkdtempSync(join(import.meta.dir, ".seat-admin-lock-"));
  dirs.push(dir);
  return join(dir, "cleanup.lock");
};

test("a surviving helper holds the lock; busy destroys retry without overlapping work", async () => {
  const path = lockPath();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const survivor = withSeatAdminLock(path, false, async () => { started(); await held; });
  await entered;
  let active = 1;
  let peak = 1;
  let attempts = 0;
  const queue = new CleanupQueue(async () => {
    attempts++;
    try {
      return await withSeatAdminLock(path, false, async () => {
        active++;
        peak = Math.max(peak, active);
        active--;
        return { ok: true };
      }, 15);
    } catch (err) {
      expect(err).toBeInstanceOf(SeatAdminBusyError);
      return { ok: false, why: (err as Error).message };
    }
  }, { retryBaseMs: 25 });
  expect(await queue.request(2)).toMatchObject({ ok: false, why: "busy: another cleanup helper is still running" });
  expect(peak).toBe(1);
  release();
  active--;
  await survivor;
  await Bun.sleep(60);
  expect(attempts).toBeGreaterThanOrEqual(2);
  expect(peak).toBe(1);
  await queue.close();
});

test("the kernel releases a helper lock when its process crashes", async () => {
  const path = lockPath();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../fixtures/seats-lock-holder.ts"), path],
    { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await Promise.race([reader.read(), Bun.sleep(2_000).then(() => null)]);
    expect(first && new TextDecoder().decode(first.value)).toContain("held");
    await expect(withSeatAdminLock(path, false, async () => true, 15)).rejects.toBeInstanceOf(SeatAdminBusyError);
    child.kill("SIGKILL");
    await child.exited;
    expect(await withSeatAdminLock(path, false, async () => true, 100)).toBe(true);
  } finally { child.kill("SIGKILL"); await child.exited; }
});

test("unsafe lock inode and symlink fail closed", async () => {
  const path = lockPath();
  writeFileSync(path, "", { mode: 0o600 });
  chmodSync(path, 0o666);
  await expect(withSeatAdminLock(path, false, async () => true, 10)).rejects.toThrow("unsafe");
  rmSync(path);
  const target = join(path, "..");
  symlinkSync(target, path);
  await expect(withSeatAdminLock(path, false, async () => true, 10)).rejects.toThrow();
});

test("root lock refuses a writable, symlinked, or non-root parent in its chain", () => {
  const path = "/var/lib/walkie/seat-admin.sqlite.cleanup.lock";
  const safe = { dev: 1, ino: 2, uid: 0, mode: 0o755, directory: true, symlink: false, aclWritable: false };
  for (const [part, change, reason] of [
    ["/var/lib/walkie", { mode: 0o775 }, "writable"],
    ["/var/lib", { symlink: true }, "symlink"],
    ["/var", { uid: 501 }, "root"],
    ["/", { aclWritable: true }, "ACL"],
  ] as const) {
    expect(() => verifySeatLockParents(path, true, (ancestor) => ({ ...safe, ...(ancestor === part ? change : {}) })))
      .toThrow(reason);
  }
});

test("lock path replaced while waiting is refused after acquisition", async () => {
  const path = lockPath();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const holder = withSeatAdminLock(path, false, async () => { entered(); await held; });
  await started;
  const waiter = withSeatAdminLock(path, false, async () => true, 500);
  await Bun.sleep(30);
  renameSync(path, `${path}.old`);
  writeFileSync(path, "", { mode: 0o600 });
  release();
  await holder;
  await expect(waiter).rejects.toThrow("changed");
});
