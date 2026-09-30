import { expect, test } from "bun:test";
import { liveMonitorPids, rig6, teardown, waitFor } from "./orchestrator-merge7-setup.ts";

for (const path of ["monitorFailed", "bootFailed"] as const) {
  test(`${path} bounds its cleanup wait without losing the obligation`, async () => {
    const r = await rig6({ destroyMs: 5_000 });
    try {
      await r.alex.client("").orchestratorStart({ access: "full" });
      const host = r.host();
      await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
      const started = Date.now();
      if (path === "monitorFailed") {
        host.monitorFailed("monitor fault probe");
        await host.lifecycle;
      } else {
        await host.bootFailed(new Error("boot fault probe"));
      }
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(host.shellUser.pendingCleanup).not.toBeNull();
      expect(host.leadership.valid).toBe(false);
    } finally {
      await teardown(r);
      expect(liveMonitorPids(r)).toEqual([]);
    }
  }, 15_000);
}
