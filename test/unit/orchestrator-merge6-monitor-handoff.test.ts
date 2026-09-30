import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig5, waitFor, type Rig5 } from "./orchestrator-merge6-setup.ts";

let r: Rig5;
beforeAll(async () => { r = await rig5({ realMonitor: true, firstDestroyNoAnswer: true, destroyMs: 3_000 }); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("monitor exit 0 after a failed daemon cleanup completes the handoff without a fault", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  const stopped = await r.alex.client("").orchestratorStop();
  expect(stopped.local.state).toBe("cleanup_pending");
  await waitFor(() => r.monitors[0]?.code === 0 || null, { what: "monitor completed cleanup", timeoutMs: 15_000 });
  expect(host.monitorFault).toBe(false);
  expect(host.shellUser.pendingCleanup).toBeNull();
  expect(host.view().state).toBe("stopped");
  expect(r.helper.state.current).toBeNull();
}, 60_000);
