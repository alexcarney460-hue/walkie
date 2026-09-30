// P3: a person's `walkie talkie access full` is preparing the uid (slow helper) when the platform child crashes.
// The crash restart bumps the generation. Is the person's access change dropped while the call still returns 200?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { crash, rig, shellFacts, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("access change silently dropped by a crash restart", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform" });
  await waitFor(() => r.rows().length >= 1 && r.host().child?.alive, { what: "platform launch" });
  const host = r.host();
  const orig = host.prepareShellUser.bind(host);
  let k = 0;
  host.prepareShellUser = async () => { if (k++ === 0) await Bun.sleep(1_500); return orig(); };
  const access = host.setAccess("full").then((v: any) => ({ ok: true, access: v.access, state: v.state }), (e: Error) => ({ ok: false, err: e.message }));
  await waitFor(() => k >= 1, { what: "setAccess inside prepareShellUser" });
  await crash(host); // the platform child crashes meanwhile
  const res = await access;
  await waitFor(() => host.child?.alive || host.phase === "failed", { what: "post-crash state", timeoutMs: 15_000 });
  const after = { returned: res, stateAccess: host.state?.access, mode: host.state?.permission_mode, phase: host.phase, child: !!host.child?.alive,
    lastArgvBypass: r.rows().at(-1)?.argv?.includes("bypassPermissions"), rows: r.rows().length, ...shellFacts(host), adminCalls: r.adminCalls };
  console.log("P3", JSON.stringify(after));
  // Either the change is applied, or the person is told it was not (an error), never a silent 200 with the old access.
  expect(res.ok === false || host.state?.access === "full").toBe(true);
  if (res.ok) expect(res.access).toBe("full");
}, 60_000);
