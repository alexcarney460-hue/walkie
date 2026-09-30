import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";
import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { adminCall } from "../../src/daemon/seats/runner-child.ts";

test("adminCall ends when a descendant retains stdout", async () => {
  const started = Date.now();
  const result = await adminCall(["/bin/sh", "-c", "sleep 1 & printf '{\"ok\":true}\\n'"], 100);
  expect(result).toBeNull();
  expect(Date.now() - started).toBeLessThan(700);
  await Bun.sleep(1_100); // let the short-lived descendant exit before process inventory
});

test("a hung cleanup promise loses ownership and retains the obligation", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-admin-deadline-"));
  try {
    const cleanupFile = join(root, "cleanup.sqlite");
    const user = new TalkieOsUser(join(root, "daemon.sock"), () => false, {
      cleanupFile, cleanupDeadlineMs: 60,
      admin: async () => new Promise(() => undefined),
      retrySleep: () => new Promise<void>(() => undefined),
    });
    Object.assign(user, { generation: "hung-run" });
    await expect(user.destroy()).rejects.toThrow("not verified");
    const obligation = new CleanupObligation(cleanupFile);
    expect(obligation.read()?.generation).toBe("hung-run");
    await Bun.sleep(10_000);
    expect(obligation.ownerActive("hung-run")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);
