// Q5: WalkieTalkie is active but waiting for its lease (boot's acquire failed: phase "stopped", resumeTimer armed).
// The person runs `walkie talkie model sonnet`: setModel rejects 409 orchestrator_not_running, and
// restartAfterSettingsFailure() schedules a restart anyway (state.active, not stopping). Do five such refusals give up?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("model switch refused while waiting for the lease", async () => {
  const host = r.host();
  const acquire = host.leadership.acquire.bind(host.leadership);
  let n = 0;
  host.leadership.acquire = async () => (n++ === 0 ? acquire() : false); // startNow gets it; boot (and resumes) do not
  await r.alex.client("").orchestratorStart({ access: "platform" }).catch(() => undefined);
  await waitFor(() => host.phase === "stopped" && host.state?.active, { what: "waiting for lease" });
  const before = { phase: host.phase, view: host.view().state, active: host.state?.active, resumeTimer: !!host.resumeTimer, attempt: host.attempt };
  const log: any[] = [];
  for (let i = 1; i <= 5; i++) {
    const res = await host.setModel("sonnet").then(() => "ok", (e: any) => `rejected ${e.code ?? ""}`);
    await Bun.sleep(400);
    log.push({ i, res, attempt: host.attempt, phase: host.phase, view: host.view().state, gave_up: host.state?.gave_up ?? null, resumeTimer: !!host.resumeTimer, active: host.state?.active, lastError: host.lastError ?? null, stopReq: host.stopRequests, restartTimer: !!host.restartTimer });
  }
  console.log("Q5", JSON.stringify({ before, log }));
  expect(log.every((l) => l.gave_up === null && l.attempt === 0)).toBe(true);
}, 60_000);
