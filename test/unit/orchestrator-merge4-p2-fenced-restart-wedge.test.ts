// P2: a crash restart T is fenced by a person's model switch S; S then fails in prepareShellUser (keychain unavailable ->
// talkie_login_required, or a helper failure). T has already given up its launch. Does anything restart Claude?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { crash, rig, shellFacts, waitFor, WT, type Rig } from "./orchestrator-merge4-setup.ts";
const { HttpError } = await import(`${WT}/src/daemon/http.ts`);
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("switch fails after fencing the crash restart", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => r.rows().length >= 1 && r.host().child?.alive, { what: "shell launch" });
  const host = r.host();
  const orig = host.prepareShellUser.bind(host);
  let k = 0;
  let restartSettled = false;
  host.prepareShellUser = async () => {
    const n = k++;
    if (n === 0) { try { await Bun.sleep(1_500); return await orig(); } finally { restartSettled = true; } }
    if (n === 1) throw new HttpError(409, "talkie_login_required", "probe: keychain unavailable"); // S: fails once
    return orig();                                                    // anything later works
  };
  await crash(host);
  await waitFor(() => k >= 1, { what: "T inside prepareShellUser" });
  const sw = await host.setModel("sonnet").then(() => "resolved", (e: Error) => `rejected: ${e.message}`);
  console.log("P2a switch", sw);
  await waitFor(() => restartSettled && host.child?.alive, { what: "fenced restart settled with live child", timeoutMs: 15_000 });
  const v = host.view();
  const after = { phase: host.phase, view: v.state, running: v.running, child: !!host.child, restartTimer: !!host.restartTimer,
    prepareCalls: k, rows: r.rows().length, last_error: v.last_error ?? null, ...shellFacts(host), adminCalls: r.adminCalls };
  console.log("P2b after restart settled", JSON.stringify(after));
  // A running WalkieTalkie with no child and no restart armed is wedged until a person stops/starts it.
  expect(sw.startsWith("rejected:")).toBe(true);
  expect(!!host.child?.alive).toBe(true);
}, 60_000);
