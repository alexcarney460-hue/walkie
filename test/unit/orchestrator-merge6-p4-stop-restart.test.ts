// Q2: the crash restart now runs inside serial(). A shell WalkieTalkie's child crashes; the restart is inside the sudo
// helper's create (slow: dscl/useradd, adminCall allows 180 s per verb). The person presses Stop. How long until Stop
// resolves (it is queued behind the restart), and does anything spawn after Stop was issued? Also: daemon close().
import { afterAll, beforeAll, expect, test } from "bun:test";
import { helperEmulator, rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
const HOLD = Number(process.env.Q2_HOLD_MS ?? 6_000);
let r: Rig;
const timing = { ms: 100 };
const helper = helperEmulator(timing);
beforeAll(async () => { r = await rig(); r.hook.fn = helper.fn; }, 60_000);
afterAll(async () => { await r.c.close(); });

test("stop behind a restart in the helper", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.host().child?.alive, { what: "shell launch" });
  const host = r.host();
  const spawns: number[] = [];
  const spawn = host.spawn.bind(host);
  host.spawn = (a: string, b: boolean) => { spawns.push(Date.now()); return spawn(a, b); };
  // The uid is already live, so the restart adopts it; force a fresh prepare by destroying first (as a crash + lease blip would).
  await host.shellUser.destroy();
  timing.ms = HOLD;
  host.child.terminate();
  await waitFor(() => r.count("talkie-create") >= 2, { what: "restart inside helper create", timeoutMs: 10_000 });
  const t0 = Date.now();
  const stopRes = await r.alex.client("").orchestratorStop().then(() => "ok", (e: any) => `rejected ${e.status} ${e.message}`);
  const stopMs = Date.now() - t0;
  await Bun.sleep(300);
  await waitFor(() => (host.shellUser.generation === null && host.shellUser.pendingCleanup === null) || null, { what: "obligation reconciled", timeoutMs: 20_000 }).catch(() => undefined); const out = { stopRes, stopMs, gen: host.shellUser.generation, pending: host.shellUser.pendingCleanup, view: host.view().state, stopped_by_hand: host.state?.stopped_by_hand, active2: host.state?.active, spawnsAfterStop: spawns.filter((t) => t >= t0).length, phase: host.phase, child: !!host.child?.alive,
    active: host.shellUser.active, helperCurrent: helper.state.current?.slice(0, 8) ?? null, helperLog: helper.state.log, admin: r.adminCalls };
  console.log("Q2", JSON.stringify(out));
  expect(out.spawnsAfterStop).toBe(0);
  expect(out.helperCurrent).toBeNull();
  expect(stopMs).toBeLessThan(2_800);
}, 60_000);
