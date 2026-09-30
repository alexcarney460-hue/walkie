// X6 (attack 3): daemon shutdown (the real main.ts stop(): orchestrator.close(), seats, store, pid file) while a
// full-access run's helper destroy takes DESTROY_MS and FAILS, then a new daemon on the same home. The old daemon's
// in-memory work is neutered after its stop() (in production the process has exited). Does shutdown complete, and does
// the next daemon reconcile the durable pending generation? What happens to the resumed (active) run?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ev, events, facts, liveMonitorPids, rig6, teardown, waitFor, type Rig6 } from "./orchestrator-merge7-setup.ts";
const DESTROY_MS = Number(process.env.DESTROY_MS ?? 3_000);
let r: Rig6;
beforeAll(async () => { r = await rig6({ destroyMs: DESTROY_MS, destroyFail: true }); }, 60_000);
afterAll(async () => { await teardown(r); expect(liveMonitorPids(r)).toEqual([]); });

test(`daemon restart during a failing ${DESTROY_MS} ms uid cleanup`, async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const old = r.host();
  await waitFor(() => old.child?.alive && old.shellUser.active, { what: "shell child" });
  await Bun.sleep(600);
  const home = old.core.paths.home;
  const cleanupFile = join(home, "orchestrator-uid-cleanup.sqlite");
  const durable = () => { const db = new Database(cleanupFile, { readonly: true }); try { return db.query("SELECT generation, attempts FROM obligation").all(); } finally { db.close(); } };
  // After the old daemon's stop() returns, its process is gone in production: no fault handler, no in-memory retry.
  let oldDead = false;
  const monitorFailed = old.monitorFailed.bind(old);
  old.monitorFailed = (reason: string) => { if (oldDead) { ev(`(old daemon, exited in production) monitorFailed: ${reason}`); return; } ev(`old daemon monitorFailed BEFORE its stop() returned: ${reason}`); monitorFailed(reason); };
  const armRetry = old.shellUser.armRetry.bind(old.shellUser);
  old.shellUser.armRetry = (ms: number) => { if (oldDead) { ev(`(old daemon, exited in production) armRetry(${ms})`); return; } armRetry(ms); };
  ev("daemon stop()");
  const t0 = Date.now();
  const stopRes = await r.alex.stop().then(() => "resolved", (e: any) => `rejected ${e.message}`);
  oldDead = true;
  ev(`daemon stop() ${stopRes} after ${Date.now() - t0} ms; pid file exists: ${existsSync(join(home, "walkie.pid"))}`);
  const savedAfterStop = JSON.parse(readFileSync(join(home, "orchestrator.json"), "utf8"));
  const durableAtStop = durable();
  r.timing.destroyFail = false;
  ev("new daemon start()");
  await r.alex.start();
  const host = r.host();
  await waitFor(() => (host.shellUser.pendingCleanup === null && r.helper.state.current === null) || null, { what: "reconciled", timeoutMs: 20_000 }).catch(() => undefined);
  await waitFor(() => host.child?.alive || null, { what: "resumed shell child", timeoutMs: 15_000 }).catch(() => undefined);
  const end = { ...facts(host), durable: durable(), saved: JSON.parse(readFileSync(join(home, "orchestrator.json"), "utf8")) };
  console.log("X6", JSON.stringify({ DESTROY_MS, stopRes, savedAfterStop: { active: savedAfterStop.active, access: savedAfterStop.access, mode: savedAfterStop.mode ?? null },
    durableAtStop, end: { ...end, saved: { active: end.saved.active, mode: end.saved.mode ?? null } }, monitors: r.monitors.map((m) => ({ run: m.run.slice(0, 8), code: m.code })),
    helper: r.helper.state.log, admin: r.adminCalls, events }, null, 1));
  expect(end.pending).toBeNull();
  expect(end.active).toBe(true);
  expect(end.child).toBe(true);
  expect(r.helper.state.current).toBe(host.shellUser.generation);
}, 90_000);
