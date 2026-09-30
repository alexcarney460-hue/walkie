import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";

test("Start accepts verified monitor cleanup after daemon cleanup rejects", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-completed-start-"));
  const home = join(root, "walkie-talkie"); mkdirSync(home);
  const cleanupFile = join(root, "cleanup.sqlite");
  const oldRun = "monitor-finished";
  const obligation = new CleanupObligation(cleanupFile);
  expect(obligation.record(oldRun)).toBe(true);
  const user = new TalkieOsUser(join(root, "daemon.sock"), () => false, {
    ready: () => true, privateHome: () => null, socketRoot: root, cleanupFile,
    admin: async (_verb, generation) => ({ ok: true, name: "walkie-talkie", uid: 550_000, home, generation }),
  });
  let rejectCleanup: (error: Error) => void = () => undefined;
  const cleaning = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
  Object.assign(user, { generation: oldRun, cleaningGeneration: oldRun, cleaning });
  try {
    const starting = user.prepare();
    expect(obligation.clear(oldRun)).toBe(true); // separate monitor completes while Start waits
    rejectCleanup(new Error("record refused after monitor clear"));
    await starting;
    expect(user.active).toBe(true);
    expect(user.pendingCleanup).toBeNull();
  } finally {
    Object.assign(user, { cleaning: null });
    await user.destroy().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
