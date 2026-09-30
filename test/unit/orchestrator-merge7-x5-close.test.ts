// X5 (attack 1/3): daemon shutdown (host.close()) of a full-access run whose helper destroy takes DESTROY_MS and then
// FAILS. close() returns after its 2 s wait and leadership.stop() runs. In production main.ts then closes seats/store,
// removes the pid file and exits, taking the daemon's in-memory retry with it. Is the out-of-process monitor still
// there to retry the failed cleanup (it was the retrier before the wait was bounded)? And is the obligation durable?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { ev, events, facts, liveMonitorPids, rig6, teardown, type Rig6 } from "./orchestrator-merge7-setup.ts";
const DESTROY_MS = Number(process.env.DESTROY_MS ?? 4_000);
let r: Rig6;
beforeAll(async () => { r = await rig6({ destroyMs: DESTROY_MS, destroyFail: true }); }, 60_000);
afterAll(async () => { await teardown(r); expect(liveMonitorPids(r)).toEqual([]); });

test(`close() with a ${DESTROY_MS} ms failing helper destroy`, async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  const { waitFor } = await import("./orchestrator-merge7-setup.ts");
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  await Bun.sleep(600);
  const cleanupFile = join(host.core.paths.home, "orchestrator-uid-cleanup.sqlite");
  const eventStart = events.length;
  const obligation = () => { const db = new Database(cleanupFile, { readonly: true }); try { return { obligation: db.query("SELECT generation, attempts, diagnostic FROM obligation").all(), owner: db.query("SELECT generation, pid, interval_ms FROM retry_owner").all() }; } finally { db.close(); } };
  ev("close()");
  const t0 = Date.now();
  const closeRes = await host.close().then(() => "resolved", (e: any) => `rejected ${e.message}`);
  const closeMs = Date.now() - t0;
  ev(`close() ${closeRes} after ${closeMs} ms  <- production daemon proceeds to seats/store close and process.exit`);
  const atClose = { ...facts(host), durable: obligation(), monitorCode: r.monitors[0]?.code };
  await Bun.sleep(1_000);
  const plus1s = { monitorCode: r.monitors[0]?.code, durable: obligation() };
  await Bun.sleep(DESTROY_MS);
  const end = { ...facts(host), monitorCode: r.monitors[0]?.code, durable: obligation() };
  console.log("X5", JSON.stringify({ DESTROY_MS, closeRes, closeMs, atClose, plus1s, end, test_pid: process.pid, helper: r.helper.state.log, events }, null, 1));
  expect(r.monitors[0]?.code).toBe("pending");
  expect(atClose.active).toBe(true);
  expect(end.monitorFault).toBe(false);
  expect(end.active).toBe(true);
  expect(end.durable.obligation).toHaveLength(1);
  expect(events.slice(eventStart).some((line) => line.includes("monitor: helper destroy("))).toBe(true);
}, 60_000);
