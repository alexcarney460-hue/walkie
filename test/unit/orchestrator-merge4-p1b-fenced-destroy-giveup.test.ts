// P1b: same race as P1, with a history of 3 rapid failures. Does the fenced restart's destroy (which kills the child
// the person's model switch just started) count as a crash and push a healthy, freshly switched WalkieTalkie into give-up?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { crash, rig, shellFacts, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("stale destroy kills the switched child and triggers give-up", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.rows().length >= 1 && r.host().child?.alive, { what: "shell launch" });
  const host = r.host();
  const orig = host.prepareShellUser.bind(host);
  let k = 0;
  let restartSettled = false;
  host.prepareShellUser = async () => { if (k++ === 0) { try { await Bun.sleep(1_500); return await orig(); } finally { restartSettled = true; } } return orig(); };
  host.attempt = 3;
  await crash(host);
  await waitFor(() => k >= 1, { what: "T inside prepareShellUser" });
  await host.setModel("sonnet");
  const sChild = host.child;
  console.log("P1b-a", JSON.stringify({ sChildAlive: !!sChild?.alive, attempt: host.attempt, phase: host.phase, ...shellFacts(host) }));
  await waitFor(() => restartSettled, { what: "fenced restart settled", timeoutMs: 15_000 });
  const v = host.view();
  const after = { sChildAlive: !!sChild?.alive, phase: host.phase, view: v.state, gave_up: host.state?.gave_up ?? null, attempt: host.attempt,
    last_error: v.last_error ?? null, destroys: r.count("talkie-destroy"), creates: r.count("talkie-create"), ...shellFacts(host) };
  console.log("P1b-b", JSON.stringify(after));
  expect(after.gave_up).toBeNull();
}, 60_000);
