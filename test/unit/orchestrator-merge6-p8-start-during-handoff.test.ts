// P8: why the platform Start in P2 failed: a person's Start while the old run's monitor owns the handed-off cleanup.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { facts, rig5, waitFor, type Rig5 } from "./orchestrator-merge6-setup.ts";
let r: Rig5;
beforeAll(async () => { r = await rig5({ realMonitor: true, destroyMs: 3_000 }); }, 60_000);
afterAll(async () => { await r.c.close(); });
test("start while the monitor owns the handed-off cleanup", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  const stopErr = await host.stopByHand().then(() => null, (e: any) => `${e.constructor?.name}: ${e.message}`);
  const t0 = Date.now();
  const startErr = await host.start({ access: "platform" }).then(() => null, (e: any) => `${e.constructor?.name} ${e.status ?? ""}: ${e.message}`);
  console.log("P8", JSON.stringify({ stopErr, startErr, startMs: Date.now() - t0, lease: host.leadership.valid, after: facts(host) }));
  expect(stopErr).toBeNull();
  expect(startErr).toBeNull();
  expect(host.child?.alive).toBe(true);
  expect(host.monitorFault).toBe(false);
}, 60_000);
