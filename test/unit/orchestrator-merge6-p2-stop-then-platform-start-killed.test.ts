// P2: P1, then the person starts WalkieTalkie again with PLATFORM access right after Stop answered (a platform start
// does not wait for the shell uid's cleanup). The old run's monitor then finishes the handed-off cleanup and exits 0.
// Does that stop the NEW, healthy platform run and flag a monitor fault on it?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { facts, rig5, waitFor, type Rig5 } from "./orchestrator-merge6-setup.ts";
const DESTROY_MS = Number(process.env.DESTROY_MS ?? 3_000);
let r: Rig5;
beforeAll(async () => { r = await rig5({ realMonitor: true, destroyMs: DESTROY_MS }); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("platform start right after a slow full-access Stop", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  const stopRes = await r.alex.client("").orchestratorStop().then(() => "ok", (e: any) => `rejected ${e.status ?? ""} ${e.message}`);
  const startRes = await r.alex.client("").orchestratorStart({ access: "platform" }).then(() => "ok", (e: any) => `rejected ${e.status ?? ""} ${e.message}`);
  const platformUp = await waitFor(() => host.child?.alive || null, { what: "platform child", timeoutMs: 5_000 }).then(() => true, () => false);
  const newChild = host.child;
  const afterStart = facts(host);
  await waitFor(() => r.monitors.every((m) => m.code !== "pending") || null, { what: "monitor exit", timeoutMs: 15_000 }).catch(() => undefined);
  await Bun.sleep(800);
  const end = { ...facts(host), newChildAlive: !!newChild?.alive };
  let sayRes: string;
  try { host.say("still there?", undefined, { via: "cli" }); sayRes = "accepted"; } catch (e: any) { sayRes = `refused ${e.status} ${e.message}`; }
  const retryRes = await r.alex.client("").orchestratorStart({ access: "platform" }).then(() => "ok", (e: any) => `rejected ${e.status ?? ""} ${e.message}`);
  const retryUp = await waitFor(() => host.child?.alive || null, { what: "platform child (retry)", timeoutMs: 5_000 }).then(() => true, () => false);
  const afterRetry = facts(host);
  console.log("P2", JSON.stringify({ stopRes, startRes, platformUp, afterStart, end, sayRes, retryRes, retryUp, afterRetry, monitors: r.monitors }));
  expect(stopRes).toBe("ok");
  expect(startRes).toBe("ok");
  expect(platformUp).toBe(true);
  expect(end.newChildAlive).toBe(true);
  expect(end.monitorFault).toBe(false);
  expect(sayRes).toBe("accepted");
}, 60_000);
