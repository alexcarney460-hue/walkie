// P1: halt() now bounds the shell-user destroy at 2 s (fenceFinal() at its top always sets `stopping`). With a REAL
// uid monitor (monitorUid in-process) and a helper destroy that takes DESTROY_MS: the person's Stop of a full-access
// run. What does Stop answer, and what happens when the monitor finishes the handed-off cleanup?
// Expected-correct: Stop succeeds (or reports cleanup pending) and no uid-monitor FAULT is raised afterwards.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { facts, rig5, waitFor, type Rig5 } from "./orchestrator-merge6-setup.ts";
const DESTROY_MS = Number(process.env.DESTROY_MS ?? 3_000);
let r: Rig5;
beforeAll(async () => { r = await rig5({ realMonitor: true, destroyMs: DESTROY_MS }); }, 60_000);
afterAll(async () => { await r.c.close(); });

test(`Stop of a full-access run with a ${DESTROY_MS} ms helper destroy`, async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  const before = facts(host);
  const t0 = Date.now();
  const stopView = await r.alex.client("").orchestratorStop();
  const stopMs = Date.now() - t0;
  const afterStop = facts(host);
  // Give the monitor time to take the handed-off cleanup and exit.
  await waitFor(() => r.monitors.every((m) => m.code !== "pending") || null, { what: "monitor exit", timeoutMs: 15_000 }).catch(() => undefined);
  await Bun.sleep(500);
  const end = facts(host);
  console.log("P1", JSON.stringify({ DESTROY_MS, before, stopMs, afterStop, end, monitors: r.monitors, helper: r.helper.state }));
  expect(stopView.local.state).toBe("cleanup_pending");
  expect(stopMs).toBeLessThan(2_800);
  expect(end.monitorFault).toBe(false);
  expect(end.pending).toBeNull();
}, 60_000);
