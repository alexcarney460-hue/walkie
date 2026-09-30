// X2: lease loss (leaseLost -> halt(), no Stop) on an AUTOMATIC full-access run, helper destroy DESTROY_MS (default
// 1.5 s: below the 2 s Stop wait, so this is not about the bound). The lease is already invalid, so the next lease
// renewal writes expires = 0 while the daemon's own helper call (which recorded the daemon as retry owner) runs.
// Then the auto loop's "run" decision once the lease is back. Expected-correct: no monitor fault, auto restarts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ev, events, facts, rig6, teardown, waitFor, type Rig6 } from "./orchestrator-merge7-setup.ts";
const DESTROY_MS = Number(process.env.DESTROY_MS ?? 1_500);
let r: Rig6;
beforeAll(async () => { r = await rig6({ destroyMs: DESTROY_MS }); }, 60_000);
afterAll(async () => { await teardown(r); });

test(`lease loss, ${DESTROY_MS} ms helper destroy, cross-process monitor, then an automatic start`, async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  host.state = { ...host.state, mode: "auto" };
  await Bun.sleep(600);
  // As Leadership does on expiry: the holder is invalid, then lost() -> leaseLost().
  host.leadership.stop();
  ev("lease lost");
  host.leaseLost();
  await waitFor(() => r.monitors.every((m) => m.code !== "pending") || null, { what: "monitor exit", timeoutMs: 15_000 }).catch(() => undefined);
  await Bun.sleep(DESTROY_MS + 800);
  const afterMonitor = facts(host);
  const gen = host.handGen;
  const applied = await host.serial(() => host.applyAuto({ kind: "run" }, gen)).then(() => "ok", (e: any) => `rejected ${e.message}`);
  const up = await waitFor(() => host.child?.alive || null, { what: "auto restart", timeoutMs: 5_000 }).then(() => true, () => false);
  const end = facts(host);
  console.log("X2", JSON.stringify({ DESTROY_MS, afterMonitor, applied, up, end, monitors: r.monitors, helper: r.helper.state.log, events }, null, 1));
  expect(afterMonitor.monitorFault).toBe(false);
  expect(up).toBe(true);
}, 60_000);
