// P8: P1 with a person's Start instead of a model switch. A crash restart T sits in prepareShellUser (slow keychain read);
// the person presses Start (restart by hand). Start halts, destroys, recreates the uid and spawns. When T resumes it is
// fenced: does its destroy() take down the uid and child the person's Start just created?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { crash, rig, shellFacts, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("fenced restart destroy vs a person's Start", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.rows().length >= 1 && r.host().child?.alive, { what: "shell launch" });
  const host = r.host();
  const orig = host.prepareShellUser.bind(host);
  let k = 0;
  let restartSettled = false;
  host.prepareShellUser = async () => { if (k++ === 0) { try { await Bun.sleep(1_500); return await orig(); } finally { restartSettled = true; } } return orig(); };
  await crash(host);
  console.log("P8 crash", JSON.stringify({ phase: host.phase, stopping: host.stopping, active: host.state?.active, timer: !!host.restartTimer, child: !!host.child, view: host.view() }));
  await waitFor(() => k >= 1, { what: "T inside prepareShellUser" });
  await r.alex.client("").orchestratorStart({ access: "full" }); // the person's Start
  await waitFor(() => host.child?.alive, { what: "Start's child" });
  const startChild = host.child;
  const at = { ...shellFacts(host), destroys: r.count("talkie-destroy"), creates: r.count("talkie-create") };
  console.log("P8a after Start", JSON.stringify(at));
  await waitFor(() => restartSettled && host.shellUser.cleaning === null,
    { what: "fenced restart cleanup settled", timeoutMs: 15_000 });
  const after = { startChildAlive: !!startChild?.alive, sameChild: host.child === startChild, ...shellFacts(host), sameUid: host.shellUser.generation === at.generation,
    destroys: r.count("talkie-destroy"), creates: r.count("talkie-create"), phase: host.phase, attempt: host.attempt, adminCalls: r.adminCalls };
  console.log("P8b after T fenced", JSON.stringify(after));
  expect(after.destroys).toBe(at.destroys);
  expect(after.startChildAlive).toBe(true);
}, 60_000);
