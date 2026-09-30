// P1: a restart timer T is fenced by a newer settings switch S while T awaits prepareShellUser (slow keychain read).
// S adopts the live uid and spawns its child. Does T's fenced-out `shellUser.destroy()` then tear down the uid S is using?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { crash, rig, shellFacts, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("fenced restart destroys the uid a newer switch adopted", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.rows().length >= 1 && r.host().child?.alive, { what: "shell launch" });
  const host = r.host();
  const orig = host.prepareShellUser.bind(host);
  let k = 0;
  let restartSettled = false;
  host.prepareShellUser = async () => { if (k++ === 0) { try { await Bun.sleep(1_500); return await orig(); } finally { restartSettled = true; } } return orig(); };
  const gen0 = host.shellUser.generation;
  await crash(host);
  await waitFor(() => k >= 1, { what: "T inside prepareShellUser" });
  await host.setModel("sonnet"); // S: the person's model switch; adopts the live uid and spawns
  const sChild = host.child;
  const atSwitch = { childAlive: !!sChild?.alive, pid: sChild?.pid, ...shellFacts(host), sameUid: host.shellUser.generation === gen0,
    destroys: r.count("talkie-destroy"), creates: r.count("talkie-create"), phase: host.phase, rows: r.rows().length,
    lastArgvBypass: r.rows().at(-1)?.argv?.includes("bypassPermissions"), lastModel: r.rows().at(-1)?.argv?.[r.rows().at(-1).argv.indexOf("--model") + 1] };
  console.log("P1a after S spawned", JSON.stringify(atSwitch));
  await waitFor(() => restartSettled && host.shellUser.cleaning === null,
    { what: "fenced restart cleanup settled", timeoutMs: 15_000 });
  const after = { sameChild: host.child === sChild, childAlive: !!host.child?.alive, ...shellFacts(host),
    destroys: r.count("talkie-destroy"), creates: r.count("talkie-create"), phase: host.phase, view: host.view().state,
    running: host.view().running, acceptsToken: host.acceptsToken(host.childToken), adminCalls: r.adminCalls };
  console.log("P1b after T fenced", JSON.stringify(after));
  // Correct behaviour: the fenced-out attempt must not destroy a uid the newer attempt is running on.
  expect(after.destroys).toBe(atSwitch.destroys);
  expect(after.active).toBe(true);
}, 60_000);
