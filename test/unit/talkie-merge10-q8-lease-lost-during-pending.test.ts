// R9 probe Q8: the lead lease is kept through a pending uid cleanup (7bbd820). What if the lease is LOST during the wait (authority blip:
// leaseLost() sets state.active=false)? Then (i) does the boot-retry loop end, (ii) in auto mode does the pilot churn acquire -> start
// (409 talkie_cleanup_pending) -> stopNow -> leadership.stop() every tick, and (iii) is anything left retrying the cleanup itself?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { events, facts, liveMonitorPids, rig6, teardown, waitFor, type Rig6 } from "./orchestrator-merge7-setup.ts";
let r: Rig6;
beforeAll(async () => { r = await rig6({ destroyMs: 300, destroyFail: true, orchestrator: { auto: true, autoCheckMs: 500, leadOfflineMs: 1_500, logins: async () => ({ found: ["claude"], claude: "cli" }) } }); }, 60_000);
afterAll(async () => { await teardown(r); expect(liveMonitorPids(r)).toEqual([]); });

test("lease lost while cleanup pending (auto mode)", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const old = r.host();
  await waitFor(() => old.child?.alive && old.shellUser.active, { what: "shell child" });
  let oldDead = false;
  const mf = old.monitorFailed.bind(old); old.monitorFailed = (x: string) => { if (!oldDead) mf(x); };
  const ar = old.shellUser.armRetry.bind(old.shellUser); old.shellUser.armRetry = (ms: number) => { if (!oldDead) ar(ms); };
  await r.alex.stop();
  oldDead = true;
  await Bun.sleep(1_000);
  await r.alex.start();
  const host = r.host();
  await waitFor(() => host.lastError?.includes("cleanup pending") && host.resumeTimer, { what: "cleanup wait", timeoutMs: 10_000 });
  const counts = { acquire: 0, stop: 0, autoStart: 0, bootFailed: 0, boot: 0 };
  const wrap = (obj: any, name: string, key: keyof typeof counts) => { const f = obj[name].bind(obj); obj[name] = (...a: unknown[]) => { counts[key]++; return f(...a); }; };
  wrap(host.leadership, "acquire", "acquire"); wrap(host.leadership, "stop", "stop"); wrap(host, "autoStart", "autoStart"); wrap(host, "bootFailed", "bootFailed"); wrap(host, "boot", "boot");
  const before = { ...counts, valid: host.leadership.valid, active: host.state?.active };
  host.leaseLost(); // what Leadership's holder.invalidate() does when the authority lease lapses
  const samples: string[] = []; const T = Date.now();
  for (let i = 0; i < 24; i++) {
    await Bun.sleep(500);
    if (i % 3 === 0) samples.push(`${Date.now() - T}ms valid=${host.leadership.valid} active=${host.state?.active} view=${host.view().state} acquire=${counts.acquire} stop=${counts.stop} autoStart=${counts.autoStart} bootFailed=${counts.bootFailed} boot=${counts.boot} resumeTimer=${!!host.resumeTimer} pending=${!!host.shellUser.pendingCleanup}`);
  }
  const during = { ...counts };
  r.timing.destroyFail = false;
  const cleared = await waitFor(() => host.shellUser.pendingCleanup ? null : true, { what: "cleanup cleared", timeoutMs: 40_000 }).then(() => true, () => false);
  await Bun.sleep(3_000);
  const f = facts(host);
  console.log("Q8", JSON.stringify({ before, during, samples, cleared, afterCleared: { phase: f.phase, child: f.child, view: f.view, lease: f.lease, active: f.active }, events: events.slice(-4) }, null, 1));
  expect(cleared).toBe(true);
  expect(during.acquire).toBe(0);
  expect(during.autoStart).toBe(0);
  expect(during.bootFailed).toBe(0);
  await waitFor(() => host.child?.alive && host.state?.active, { what: "automatic boot after cleanup", timeoutMs: 15_000 });
}, 120_000);
