import { expect, test } from "bun:test";
import { rig6, teardown } from "./orchestrator-merge7-setup.ts";

test("an unused, unreadable cleanup store does not block non-shell auto decisions", async () => {
  const r = await rig6();
  try {
    const host = r.host();
    let reads = 0;
    Object.defineProperty(host.shellUser, "pendingCleanup", { configurable: true, get: () => {
      reads++;
      throw new Error("unsafe uid cleanup state file");
    } });
    await host.applyAuto({ kind: "none" });
    await host.applyAuto({ kind: "stopped" });
    await host.applyAuto({ kind: "standby", lead: "another machine" });
    await host.applyAuto({ kind: "run" });
    expect(reads).toBe(0);
    expect(host.view().last_error).toContain("Check the cleanup state file");
  } finally { await teardown(r); }
}, 30_000);
