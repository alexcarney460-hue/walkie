// Attack 1 (stop-vs-restart): a person's stop lands while a restart timer is mid-flight in shell mode.
// Does the in-flight restart create a new dedicated uid after the stop's destroy?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rig, waitFor, type Rig } from "./orchestrator-race-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("stop by hand during an in-flight shell restart", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.rows().length >= 1, { what: "shell launch" });
  const host = r.host();
  const orig = host.detectLogins.bind(host);
  let n = 0;
  host.detectLogins = async () => { if (n++ === 0) await Bun.sleep(2_000); return orig(); };
  host.child?.terminate(); // a crash: restart timer arms, fires, sits in the slow step
  await waitFor(() => n >= 1, { what: "restart timer in its slow pre-spawn step" });
  await r.alex.client("").orchestratorStop();
  const atStop = { creates: r.adminCalls.filter((v) => v === "talkie-create").length, active: host.shellUser.active, leadershipValid: host.leadership.valid };
  console.log("S1 after stop", JSON.stringify({ ...atStop, phase: host.phase, view: host.view().state }));
  await Bun.sleep(3_000);
  const sock = host.shellUser.active ? host.shellUser.socket : null;
  const after = { creates: r.adminCalls.filter((v) => v === "talkie-create").length, active: host.shellUser.active,
    socketExists: sock ? existsSync(sock) : null, monitorTimer: !!host.shellUser.monitorTimer, rows: r.rows().length, childAlive: !!host.child?.alive,
    phase: host.phase, view: host.view().state, leadershipValid: host.leadership.valid, adminCalls: r.adminCalls };
  console.log("S2 3s later", JSON.stringify(after));
  expect(after.creates).toBe(atStop.creates);
  expect(after.active).toBe(false);
}, 60_000);
