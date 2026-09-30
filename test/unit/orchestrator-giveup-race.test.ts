// Attack 1: a restart timer already running (awaiting its pre-spawn steps) when a concurrent child gives up.
// Does the give-up cleanup hold, or does the old timer create a new uid and respawn Claude after the destroy?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rig, waitFor, type Rig } from "./orchestrator-race-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig({ runtimeBody: `if [ -f '$ROOT/crash' ]; then echo boom >&2; exit 3; fi` }); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("give-up while an earlier restart timer is mid-flight", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.rows().length >= 1, { what: "shell launch" });
  const host = r.host();
  const orig = host.detectLogins.bind(host);
  let n = 0;
  host.detectLogins = async () => { if (n++ === 0) await Bun.sleep(3_000); return orig(); };
  host.attempt = 3; // one more failure after this restart gives up
  writeFileSync(join(r.root, "crash"), "1");
  host.child?.terminate();
  await waitFor(() => n >= 1, { what: "restart timer T_a inside its slow pre-spawn step" });
  console.log("A0", JSON.stringify({ phase: host.phase, attempt: host.attempt, restartTimerArmed: !!host.restartTimer }));
  // The person changes the model while the dashboard shows "Restarting": switchModel spawns C1, which crashes -> give-up.
  await host.setModel("sonnet");
  await waitFor(() => host.phase === "failed", { what: "give-up", timeoutMs: 5_000 });
  await waitFor(() => !host.shellUser.active, { what: "uid destroyed by give-up" });
  const atGiveUp = { rows: r.rows().length, creates: r.adminCalls.filter((v) => v === "talkie-create").length,
    destroys: r.adminCalls.filter((v) => v === "talkie-destroy").length, gave_up: host.state?.gave_up ?? false };
  console.log("A1 at give-up", JSON.stringify({ ...atGiveUp, phase: host.phase, view: host.view().state, shellActive: host.shellUser.active }));
  rmSync(join(r.root, "crash"));
  await Bun.sleep(4_000); // T_a resumes after its 3 s step
  const after = { rows: r.rows().length, creates: r.adminCalls.filter((v) => v === "talkie-create").length,
    destroys: r.adminCalls.filter((v) => v === "talkie-destroy").length, gave_up: host.state?.gave_up ?? false };
  const lastSock = host.shellUser.active ? host.shellUser.socket : null;
  console.log("A2 4s later", JSON.stringify({ ...after, phase: host.phase, view: host.view().state, running: host.view().running,
    shellActive: host.shellUser.active, socketExists: lastSock ? existsSync(lastSock) : null, childAlive: !!host.child?.alive,
    leadershipValid: host.leadership.valid, adminCalls: r.adminCalls }));
  // What the round-2 claim requires: after give-up, nothing respawns and no uid is recreated until a person acts.
  expect(after.creates).toBe(atGiveUp.creates);
  expect(after.rows).toBe(atGiveUp.rows);
  expect(host.phase).toBe("failed");
  expect(host.shellUser.active).toBe(false);
}, 60_000);
