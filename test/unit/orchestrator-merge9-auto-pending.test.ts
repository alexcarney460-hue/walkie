import { expect, test } from "bun:test";
import { liveMonitorPids, rig6, teardown, waitFor } from "./orchestrator-merge7-setup.ts";

test("auto pilot keeps one lead lease and does not restart while uid cleanup is pending", async () => {
  const r = await rig6({ destroyMs: 300, destroyFail: true, orchestrator: {
    auto: true, autoCheckMs: 500, leadOfflineMs: 1_500,
    logins: async () => ({ found: ["claude"], claude: "cli" }),
  } });
  try {
    await r.alex.client("").orchestratorStart({ access: "full" });
    const old = r.host();
    await waitFor(() => old.child?.alive && old.shellUser.active, { what: "shell child" });
    let oldDead = false;
    const failed = old.monitorFailed.bind(old);
    old.monitorFailed = (reason: string) => { if (!oldDead) failed(reason); };
    const retry = old.shellUser.armRetry.bind(old.shellUser);
    old.shellUser.armRetry = (ms: number) => { if (!oldDead) retry(ms); };
    await r.alex.stop();
    oldDead = true;
    await Bun.sleep(1_000);
    await r.alex.start();
    const host = r.host();
    await waitFor(() => host.lastError?.includes("cleanup pending") && host.resumeTimer,
      { what: "cleanup wait", timeoutMs: 8_000 });
    let restarts = 0;
    const autoStart = host.autoStart.bind(host);
    host.autoStart = async (...args: unknown[]) => { restarts++; return autoStart(...args); };
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(300);
      expect(host.leadership.valid).toBe(true);
      expect(host.shellUser.pendingCleanup).not.toBeNull();
    }
    expect(restarts).toBe(0);
    const other = "b".repeat(16);
    expect(host.leadership.book.grant(host.core.nodeId, other, other).granted).toBe(false);
    r.timing.destroyFail = false;
    await waitFor(() => host.child?.alive && host.shellUser.active && host.leadership.valid,
      { what: "recovered shell", timeoutMs: 30_000 });
  } finally {
    await teardown(r);
    expect(liveMonitorPids(r)).toEqual([]);
  }
}, 60_000);
