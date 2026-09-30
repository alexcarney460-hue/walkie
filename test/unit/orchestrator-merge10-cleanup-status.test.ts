import { expect, test } from "bun:test";
import { rig6, teardown } from "./orchestrator-merge7-setup.ts";

test("repeated uid cleanup failures show a repair action in status", async () => {
  const r = await rig6();
  try {
    const host = r.host();
    Object.defineProperty(host.shellUser, "pendingCleanup", {
      configurable: true,
      get: () => ({ generation: "test", attempts: 12, diagnostic: "helper did not answer" }),
    });
    expect(host.view().state).toBe("cleanup_pending");
    expect(host.view().last_error).toContain("walkie talkie cleanup --repair");
  } finally { await teardown(r); }
});
