// X1: a person's Stop of a full-access run whose helper destroy takes DESTROY_MS (> the 2 s Stop wait), with the uid
// monitor in its OWN process. Stop returns at ~2 s and then leadership.stop() runs; the monitor lease is still renewed
// (monitorTimer is only cleared after attemptCleanup returns) but now with expires = 0. The monitor sees an invalid
// lease, tries CleanupObligation.record() while the DAEMON owns the retry (interval 180 s) and is refused.
// Expected-correct: no monitor fault, no spurious lastError, the uid is cleaned by the daemon's call.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ev, events, facts, rig6, teardown, waitFor, type Rig6 } from "./orchestrator-merge7-setup.ts";
const DESTROY_MS = Number(process.env.DESTROY_MS ?? 4_000);
let r: Rig6;
beforeAll(async () => { r = await rig6({ destroyMs: DESTROY_MS }); }, 60_000);
afterAll(async () => { await teardown(r); });

test(`Stop, ${DESTROY_MS} ms helper destroy, cross-process monitor`, async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  await Bun.sleep(600); // let the monitor settle into its poll loop
  ev("POST stop");
  const t0 = Date.now();
  const stopRes = await r.alex.client("").orchestratorStop().then((v: any) => `ok ${v.local?.state}`, (e: any) => `rejected ${e.status ?? ""} ${e.message}`);
  ev(`POST stop answered: ${stopRes}`);
  const stopMs = Date.now() - t0;
  const afterStop = facts(host);
  await waitFor(() => r.monitors.every((m) => m.code !== "pending") || null, { what: "monitor exit", timeoutMs: 15_000 }).catch(() => undefined);
  await Bun.sleep(DESTROY_MS + 500);
  const end = facts(host);
  console.log("X1", JSON.stringify({ DESTROY_MS, stopRes, stopMs, afterStop, end, monitors: r.monitors, helper: r.helper.state.log, events }, null, 1));
  expect(end.monitorFault).toBe(false);
  expect(end.lastError).toBeNull();
}, 60_000);
