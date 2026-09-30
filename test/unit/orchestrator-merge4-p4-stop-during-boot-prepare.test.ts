// P4: a person presses Stop while a shell Start is inside boot()'s prepareShellUser (slow helper create).
// boot() has no check after prepareShellUser: does it still launch Claude (full access, bypassPermissions) and hand it a
// queued message after the Stop was accepted?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig, shellFacts, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("stop during boot prepareShellUser", async () => {
  const host = r.host();
  const orig = host.prepareShellUser.bind(host);
  let k = 0;
  host.prepareShellUser = async () => { if (k++ === 0) await Bun.sleep(1_500); return orig(); };
  const spawns: any[] = [];
  const spawn = host.spawn.bind(host);
  host.spawn = (session: string, resume: boolean) => { spawns.push({ at: Date.now(), stopping: host.stopping, gen: host.runGeneration }); return spawn(session, resume); };
  const start = r.alex.client("").orchestratorStart({ access: "full" }).then(() => "ok", (e: Error) => `rejected: ${e.message}`);
  await waitFor(() => k >= 1, { what: "boot inside prepareShellUser" });
  const msg = host.say("run something with full shell access", undefined, { via: "cli" });
  const stopAt = Date.now();
  const stop = r.alex.client("").orchestratorStop();
  await Promise.all([start, stop]);
  const stopDone = Date.now();
  await waitFor(() => !host.child && host.phase === "stopped", { what: "stopped without child", timeoutMs: 15_000 });
  const out = { spawnsAfterStopIssued: spawns.filter((s) => s.at >= stopAt).map((s) => ({ ...s, msAfterStop: s.at - stopAt })),
    stopResolvedMs: stopDone - stopAt, launchesWithBypass: r.rows().filter((x: any) => x.argv.includes("bypassPermissions")).length,
    msgState: r.alex.d.core.store.orchMessage(msg.id)?.state, phase: host.phase, child: !!host.child, ...shellFacts(host), adminCalls: r.adminCalls };
  console.log("P4", JSON.stringify(out));
  expect(out.spawnsAfterStopIssued.length).toBe(0);
  expect(out.msgState).toBe("dropped");
}, 60_000);
