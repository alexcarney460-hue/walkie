// P3: a lease loss (Leadership.lost -> leaseLost -> halt(), which is NOT a stop request) on a full-access run whose
// helper destroy takes DESTROY_MS. halt() bounds the destroy at 2 s, hands the rest to the uid monitor, and the
// monitor's exit 0 is then treated as a monitor FAULT (requestStop + monitorFault). Does the next automatic start
// (the auto loop's "run" decision once the lease is back) still start WalkieTalkie?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { facts, rig5, waitFor, type Rig5 } from "./orchestrator-merge6-setup.ts";
const DESTROY_MS = Number(process.env.DESTROY_MS ?? 3_000);
let r: Rig5;
beforeAll(async () => { r = await rig5({ realMonitor: true, destroyMs: DESTROY_MS }); }, 60_000);
afterAll(async () => { await r.c.close(); });

test(`lease loss of a full-access run, ${DESTROY_MS} ms helper destroy, then an automatic start`, async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  // The start by hand ran in manual mode (no auto loop in this rig); make it an automatic run as the lead would be.
  host.state = { ...host.state, mode: "auto" };
  host.leaseLost();
  await Bun.sleep(2_500);
  const afterLoss = facts(host);
  await waitFor(() => r.monitors.every((m) => m.code !== "pending") || null, { what: "monitor exit", timeoutMs: 15_000 }).catch(() => undefined);
  await Bun.sleep(500);
  const afterMonitor = facts(host);
  // The auto loop's decision once this machine leads again.
  const gen = host.handGen;
  const applied = await host.serial(() => host.applyAuto({ kind: "run" }, gen)).then(() => "ok", (e: any) => `rejected ${e.message}`);
  const up = await waitFor(() => host.child?.alive || null, { what: "auto restart", timeoutMs: 5_000 }).then(() => true, () => false);
  const end = facts(host);
  console.log("P3", JSON.stringify({ DESTROY_MS, afterLoss, afterMonitor, applied, up, end, monitors: r.monitors, helper: r.helper.state.log }));
  expect(afterMonitor.monitorFault).toBe(false);
  expect(applied).toBe("ok");
  expect(up).toBe(true);
}, 60_000);
