// R7 (06726c1 side effect): daemon restart while a full-access run's uid cleanup keeps FAILING (the helper cannot verify
// removal). The new daemon's init boot acquires the lead lease, prepareShellUser answers 409 talkie_cleanup_pending, and
// bootFailed now keeps the run active and polls instead of stopNow(). Does this machine keep the WalkieTalkie lead lease
// (so no other machine can take over) and what status/view does it show while it waits?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ev, events, facts, liveMonitorPids, rig6, teardown, waitFor, type Rig6 } from "./orchestrator-merge7-setup.ts";
import { peerLive } from "../../src/daemon/orchestrator/auto.ts";
let r: Rig6;
beforeAll(async () => { r = await rig6({ destroyMs: 300, destroyFail: true }); }, 60_000);
afterAll(async () => { await teardown(r); expect(liveMonitorPids(r)).toEqual([]); });

test("restart with a persistently failing uid cleanup", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const old = r.host();
  await waitFor(() => old.child?.alive && old.shellUser.active, { what: "shell child" });
  await Bun.sleep(600);
  // the old daemon is gone after its stop() in production: neuter its in-memory retry and fault handler
  let oldDead = false;
  const mf = old.monitorFailed.bind(old); old.monitorFailed = (x: string) => { if (!oldDead) mf(x); };
  const ar = old.shellUser.armRetry.bind(old.shellUser); old.shellUser.armRetry = (ms: number) => { if (!oldDead) ar(ms); };
  ev("daemon stop()");
  await r.alex.stop();
  oldDead = true;
  await Bun.sleep(1_000);
  ev("new daemon start()");
  await r.alex.start();
  const host = r.host();
  await waitFor(() => host.lastError?.includes("cleanup pending") && host.resumeTimer || null,
    { what: "boot failed into cleanup retry", timeoutMs: 8_000 });
  const f = facts(host);
  const v = host.view();
  const out = { phase: f.phase, active: f.active, child: f.child, view: f.view, view_error: f.view_error, pending: f.pending,
    leadershipValid: host.leadership.valid, resumeTimerArmed: !!host.resumeTimer, lastError: f.lastError, running: v.running, helper: r.helper.state.log.slice(-4), events };
  console.log("R7", JSON.stringify(out, null, 1));
  expect(out.leadershipValid).toBe(true); // pending uid cleanup retains the team's lead lease
  const other = "b".repeat(16);
  expect(host.leadership.book.grant(host.core.nodeId, other, other).granted).toBe(false);
  expect(peerLive(host.core, host.core.nodeId)).toBe(false);
  expect(out.view).toBe("cleanup_pending");
  expect(out.active).toBe(true);
}, 60_000);
