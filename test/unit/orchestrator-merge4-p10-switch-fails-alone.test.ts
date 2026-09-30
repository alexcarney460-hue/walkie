// P10: control for P2 with no restart in flight: a healthy shell WalkieTalkie; the person's model switch closes the child,
// then prepareShellUser fails (keychain unavailable). Does anything relaunch Claude? (Classifies P2's wedge as new vs. old.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig, waitFor, WT, type Rig } from "./orchestrator-merge4-setup.ts";
const { HttpError } = await import(`${WT}/src/daemon/http.ts`);
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("switch fails with no restart in flight", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.host().child?.alive, { what: "shell launch" });
  const host = r.host();
  const orig = host.prepareShellUser.bind(host);
  let k = 0;
  host.prepareShellUser = async () => { if (k++ === 0) throw new HttpError(409, "talkie_login_required", "probe: keychain unavailable"); return orig(); };
  const sw = await host.setModel("sonnet").then(() => "ok", (e: Error) => `rejected: ${e.message}`);
  await waitFor(() => r.host().child?.alive || r.host().phase === "failed", { what: "switch settled", timeoutMs: 15_000 });
  const v = host.view();
  console.log("P10", JSON.stringify({ sw, phase: host.phase, view: v.state, running: v.running, child: !!host.child, restartTimer: !!host.restartTimer, shellActive: host.shellUser.active, lastError: v.last_error, attempts: host.attempt, adminCalls: r.adminCalls, rows: r.rows().length }));
  expect(sw.startsWith("rejected:")).toBe(true);
  expect(!!host.child?.alive).toBe(true);
}, 60_000);
